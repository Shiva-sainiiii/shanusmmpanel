// =====================================================================
// api/api.js — JAP Proxy Engine (balance / add / status)
// 100% database-less. All state lives client-side (LocalStorage).
// =====================================================================

const JAP_ENDPOINT = "https://justanotherpanel.com/api/v2";

// Optional hard cap on service IDs your panel is allowed to order from,
// even if JAP's live catalog contains thousands of services. Leave this
// Set EMPTY to allow any service ID that JAP's own `services` action
// confirms exists (validated live per-request below — never trust the
// client alone). Populate it only if you want to restrict your personal
// panel to a hand-picked subset.
const RESTRICT_TO_SERVICE_IDS = new Set([
    // "10216", "8646", "10442", "7973", "9424", "10018",
]);

const MAX_QUANTITY = 100000; // hard ceiling, tune to your JAP limits
const MIN_QUANTITY = 10;
const REQUEST_TIMEOUT_MS = 15000;

// In-memory cache for the services catalog. Vercel serverless functions
// are stateless/ephemeral between cold starts, so this is a best-effort
// cache (survives warm invocations only) — never a substitute for a DB.
let servicesCache = { data: null, fetchedAt: 0 };
const SERVICES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

/** Fetch with a hard timeout so a hung JAP connection can't hang the fn. */
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/** Calls the JAP v2 API with a given action + extra params. */
async function callJAP(params) {
    const body = new URLSearchParams({
        key: process.env.PROVIDER_API_KEY,
        ...params,
    });

    let japResponse;
    try {
        japResponse = await fetchWithTimeout(
            JAP_ENDPOINT,
            {
                method: "POST",
                body: body.toString(),
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
            },
            REQUEST_TIMEOUT_MS
        );
    } catch (err) {
        if (err.name === "AbortError") {
            const timeoutErr = new Error("JAP_TIMEOUT");
            timeoutErr.code = "JAP_TIMEOUT";
            throw timeoutErr;
        }
        const networkErr = new Error("JAP_NETWORK_UNREACHABLE");
        networkErr.code = "JAP_NETWORK_UNREACHABLE";
        throw networkErr;
    }

    if (!japResponse.ok) {
        const err = new Error(`JAP_HTTP_${japResponse.status}`);
        err.code = "JAP_HTTP_ERROR";
        err.httpStatus = japResponse.status;
        throw err;
    }

    let japData;
    try {
        japData = await japResponse.json();
    } catch {
        const err = new Error("JAP_INVALID_JSON");
        err.code = "JAP_INVALID_JSON";
        throw err;
    }

    if (japData && japData.error) {
        const err = new Error(japData.error);
        err.code = "JAP_REJECTED";
        throw err;
    }

    return japData;
}

/** Strict, minimal input sanitizer for the link field. */
function sanitizeLink(rawLink) {
    if (typeof rawLink !== "string") return null;
    const trimmed = rawLink.trim();
    if (trimmed.length === 0 || trimmed.length > 2048) return null;
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        return trimmed;
    } catch {
        return null;
    }
}

function isValidQuantity(q) {
    const n = Number(q);
    return Number.isInteger(n) && n >= MIN_QUANTITY && n <= MAX_QUANTITY;
}

function isValidServiceId(id) {
    if (typeof id === "undefined" || id === null || String(id).trim() === "") return false;
    // Empty restrict-set = allow any service ID (per the comment above the
    // const declaration). Non-empty = only allow IDs in the allow-list.
    if (RESTRICT_TO_SERVICE_IDS.size === 0) return /^\d+$/.test(String(id));
    return RESTRICT_TO_SERVICE_IDS.has(String(id));
}

function isValidOrderId(id) {
    const n = Number(id);
    return Number.isInteger(n) && n > 0;
}

/** Validates a comma-separated list of order/refill IDs (JAP allows up to 100). */
function parseIdList(raw) {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0 || parts.length > 100) return null;
    if (!parts.every((p) => isValidOrderId(p))) return null;
    return parts;
}

function constantTimeEquals(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
        mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
}

function checkPassword(candidate) {
    const expected = process.env.MY_PANEL_PASSWORD;
    if (!expected || !candidate) return false;
    return constantTimeEquals(String(candidate), String(expected));
}

/** Uniform granular error responder so failures are instantly traceable. */
function fail(res, httpStatus, code, message, extra) {
    return res.status(httpStatus).json({
        success: false,
        error_code: code,
        error: message,
        ...(extra ? { detail: extra } : {}),
    });
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------

module.exports = async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Panel-Password");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    // Fail fast if server env isn't configured — this is a deployment
    // problem, not a client problem, so it gets its own code.
    if (!process.env.MY_PANEL_PASSWORD || !process.env.PROVIDER_API_KEY) {
        return fail(res, 500, "SERVER_MISCONFIGURED",
            "Panel environment variables are not set on the server.");
    }

    try {
        // -------------------------------------------------------------
        // GET → balance check. Password passed via header, never query
        // string, so it never lands in Vercel access logs or browser
        // history.
        // -------------------------------------------------------------
        if (req.method === "GET") {
            const password = req.headers["x-panel-password"];
            if (!checkPassword(password)) {
                return fail(res, 401, "AUTH_INVALID", "Invalid gatekeeper token.");
            }

            try {
                const japData = await callJAP({ action: "balance" });
                return res.status(200).json({
                    success: true,
                    balance: japData.balance,
                    currency: japData.currency || "USD",
                });
            } catch (err) {
                return handleJAPError(res, err);
            }
        }

        // -------------------------------------------------------------
        // POST → disambiguated by `action`:
        //   (default/absent) = add order
        //   status            = single order status
        //   status_multi      = bulk order status (order_ids, comma-sep)
        //   cancel            = cancel order(s) (order_ids, comma-sep)
        //   refill            = create refill (order_id, or order_ids bulk)
        //   refill_status     = refill status (refill_id, or refill_ids bulk)
        // -------------------------------------------------------------
        if (req.method === "POST") {
            const payload = req.body || {};
            const { password, action } = payload;

            if (!checkPassword(password)) {
                return fail(res, 401, "AUTH_INVALID", "Invalid gatekeeper token.");
            }

            // --- Login screen check — password only, no JAP call ---------
            if (action === "verify") {
                return res.status(200).json({ success: true });
            }

            // --- Order status polling (single) ----------------------------
            if (action === "status") {
                const { order_id } = payload;
                if (!isValidOrderId(order_id)) {
                    return fail(res, 400, "VALIDATION_ORDER_ID",
                        "order_id must be a positive integer.");
                }
                try {
                    const japData = await callJAP({ action: "status", order: String(order_id) });
                    return res.status(200).json({
                        success: true,
                        order_id: Number(order_id),
                        status: japData.status,
                        charge: japData.charge,
                        start_count: japData.start_count,
                        remains: japData.remains,
                        currency: japData.currency,
                    });
                } catch (err) {
                    return handleJAPError(res, err);
                }
            }

            // --- Order status polling (bulk, up to 100 IDs) ---------------
            if (action === "status_multi") {
                const idList = parseIdList(payload.order_ids);
                if (!idList) {
                    return fail(res, 400, "VALIDATION_ORDER_IDS",
                        "order_ids must be a comma-separated list of 1-100 positive integers.");
                }
                try {
                    const japData = await callJAP({ action: "status", orders: idList.join(",") });
                    return res.status(200).json({ success: true, results: japData });
                } catch (err) {
                    return handleJAPError(res, err);
                }
            }

            // --- Cancel order(s) — JAP "cancel" action always takes a list -
            if (action === "cancel") {
                const idList = parseIdList(payload.order_ids);
                if (!idList) {
                    return fail(res, 400, "VALIDATION_ORDER_IDS",
                        "order_ids must be a comma-separated list of 1-100 positive integers.");
                }
                try {
                    const japData = await callJAP({ action: "cancel", orders: idList.join(",") });
                    return res.status(200).json({ success: true, results: japData });
                } catch (err) {
                    return handleJAPError(res, err);
                }
            }

            // --- Create refill (single or bulk) ---------------------------
            if (action === "refill") {
                const { order_id, order_ids } = payload;

                if (order_ids) {
                    const idList = parseIdList(order_ids);
                    if (!idList) {
                        return fail(res, 400, "VALIDATION_ORDER_IDS",
                            "order_ids must be a comma-separated list of 1-100 positive integers.");
                    }
                    try {
                        const japData = await callJAP({ action: "refill", orders: idList.join(",") });
                        return res.status(200).json({ success: true, results: japData });
                    } catch (err) {
                        return handleJAPError(res, err);
                    }
                }

                if (!isValidOrderId(order_id)) {
                    return fail(res, 400, "VALIDATION_ORDER_ID",
                        "order_id must be a positive integer (or pass order_ids for bulk refill).");
                }
                try {
                    const japData = await callJAP({ action: "refill", order: String(order_id) });
                    return res.status(200).json({ success: true, refill_id: japData.refill });
                } catch (err) {
                    return handleJAPError(res, err);
                }
            }

            // --- Refill status (single or bulk) ---------------------------
            if (action === "refill_status") {
                const { refill_id, refill_ids } = payload;

                if (refill_ids) {
                    const idList = parseIdList(refill_ids);
                    if (!idList) {
                        return fail(res, 400, "VALIDATION_REFILL_IDS",
                            "refill_ids must be a comma-separated list of 1-100 positive integers.");
                    }
                    try {
                        const japData = await callJAP({ action: "refill_status", refills: idList.join(",") });
                        return res.status(200).json({ success: true, results: japData });
                    } catch (err) {
                        return handleJAPError(res, err);
                    }
                }

                if (!isValidOrderId(refill_id)) {
                    return fail(res, 400, "VALIDATION_REFILL_ID",
                        "refill_id must be a positive integer (or pass refill_ids for bulk lookup).");
                }
                try {
                    const japData = await callJAP({ action: "refill_status", refill: String(refill_id) });
                    return res.status(200).json({ success: true, status: japData.status });
                } catch (err) {
                    return handleJAPError(res, err);
                }
            }

            // --- Order creation (default action) -------------------------
            const { service_id, link, quantity } = payload;

            if (!isValidServiceId(service_id)) {
                return fail(res, 400, "VALIDATION_SERVICE_ID",
                    "service_id is missing or not in the approved service catalog.");
            }

            const cleanLink = sanitizeLink(link);
            if (!cleanLink) {
                return fail(res, 400, "VALIDATION_LINK",
                    "link is missing, malformed, or not a valid http(s) URL.");
            }

            if (!isValidQuantity(quantity)) {
                return fail(res, 400, "VALIDATION_QUANTITY",
                    `quantity must be an integer between ${MIN_QUANTITY} and ${MAX_QUANTITY}.`);
            }

            try {
                const japData = await callJAP({
                    action: "add",
                    service: String(service_id),
                    link: cleanLink,
                    quantity: String(quantity),
                });

                return res.status(200).json({
                    success: true,
                    order_id: japData.order,
                });
            } catch (err) {
                return handleJAPError(res, err);
            }
        }

        return fail(res, 405, "METHOD_NOT_ALLOWED", "Only GET, POST, and OPTIONS are supported.");

    } catch (error) {
        // Last-resort catch — should rarely trigger given the try/catches
        // above, but keeps the function from ever hard-crashing silently.
        console.error("Critical Runtime Failure:", error);
        return fail(res, 500, "RUNTIME_EXCEPTION", "Unhandled server exception.", error.message);
    }
};

/** Translates a callJAP() thrown error into a granular HTTP response. */
function handleJAPError(res, err) {
    console.error("JAP call failed:", err.code || err.message, err.message);

    switch (err.code) {
        case "JAP_TIMEOUT":
            return fail(res, 504, "JAP_TIMEOUT",
                "JAP did not respond in time (15s). Their servers may be under load.");
        case "JAP_NETWORK_UNREACHABLE":
            return fail(res, 502, "JAP_NETWORK_UNREACHABLE",
                "Could not reach JAP servers. Check network/DNS from Vercel region.");
        case "JAP_HTTP_ERROR":
            return fail(res, 502, "JAP_HTTP_ERROR",
                `JAP responded with HTTP ${err.httpStatus}.`);
        case "JAP_INVALID_JSON":
            return fail(res, 502, "JAP_INVALID_JSON",
                "JAP returned a non-JSON payload — possible upstream outage or WAF block.");
        case "JAP_REJECTED": {
            // Surface the exact JAP error text so balance-dry-out vs bad
            // service vs bad link are all instantly distinguishable.
            const msg = err.message.toLowerCase();
            let subcode = "JAP_REJECTED";
            if (msg.includes("balance") || msg.includes("fund")) subcode = "JAP_INSUFFICIENT_BALANCE";
            else if (msg.includes("service")) subcode = "JAP_INVALID_SERVICE";
            else if (msg.includes("link")) subcode = "JAP_INVALID_LINK";
            else if (msg.includes("min") || msg.includes("max")) subcode = "JAP_QUANTITY_OUT_OF_RANGE";
            return fail(res, 422, subcode, `JAP rejected the request: ${err.message}`);
        }
        default:
            return fail(res, 500, "JAP_UNKNOWN_ERROR", err.message || "Unknown JAP failure.");
    }
}
