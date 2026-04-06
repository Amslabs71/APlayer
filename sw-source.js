import { FiltersEngine, Request } from "@ghostery/adblocker";

const MANUAL_FILTERS = `
||acquiredeceasedundress.com^
||pncloudfl.com^
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||adservice.google.com^
||adnxs.com^
||adsystem.com^
||popads.net^
||popcash.net^
||propellerads.com^
||propeller-tracking.com^
||onclickads.net^
||trafficjunky.net^
||exoclick.com^
||juicyads.com^
||adsterra.com^
||adsterratools.com^
||hilltopads.net^
||richads.com^
||realsrv.com^
||ad-maven.com^
||pushadmetraffic.com^
||pushwelcome.com^
||ad-delivery.net^
||adkernel.com^
||mgid.com^
||taboola.com^
||outbrain.com^
/chicken.gif
/popunder
/popup
/adserver
/vast?
/vpaid
`;

const manualEngine = FiltersEngine.parse(MANUAL_FILTERS, {
    guessRequestTypeFromUrl: true,
    loadCosmeticFilters: false
});

let ghosteryEnginePromise;

function getGhosteryEngine() {
    if (!ghosteryEnginePromise) {
        ghosteryEnginePromise = FiltersEngine
            .fromPrebuiltAdsAndTracking(fetch, {
                path: "amos-player-ghostery-adblocker-v1"
            })
            .catch((error) => {
                console.warn("Ghostery adblocker engine failed to load. Falling back to local filters.", error);
                return null;
            });
    }
    return ghosteryEnginePromise;
}

function getRequestType(request) {
    switch (request.destination) {
        case "document":
            return "sub_frame";
        case "style":
            return "stylesheet";
        case "script":
            return "script";
        case "image":
            return "image";
        case "font":
            return "font";
        case "object":
        case "embed":
            return "object";
        case "audio":
        case "video":
            return "media";
        case "manifest":
            return "web_manifest";
        default:
            return request.mode === "navigate" ? "main_frame" : "xmlhttprequest";
    }
}

async function getSourceUrl(event) {
    if (!event.clientId) return self.location.href;
    const client = await self.clients.get(event.clientId).catch(() => null);
    return client?.url || self.location.href;
}

async function shouldBlock(event) {
    const url = event.request.url;
    if (url.startsWith(self.location.origin)) return false;

    const sourceUrl = await getSourceUrl(event);
    const request = Request.fromRawDetails({
        url,
        sourceUrl,
        type: getRequestType(event.request)
    });

    if (manualEngine.match(request).match) return true;

    const ghosteryEngine = await getGhosteryEngine();
    return Boolean(ghosteryEngine?.match(request).match);
}

function blockedResponse(request) {
    if (request.destination === "script") {
        return new Response("", {
            status: 200,
            headers: { "Content-Type": "application/javascript; charset=utf-8" }
        });
    }

    if (request.destination === "document" || request.mode === "navigate") {
        return new Response("<!doctype html><html><body></body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html; charset=utf-8" }
        });
    }

    return new Response("", { status: 204 });
}

self.addEventListener("install", (event) => {
    event.waitUntil(Promise.all([
        getGhosteryEngine(),
        self.skipWaiting()
    ]));
});

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
    event.respondWith((async () => {
        if (await shouldBlock(event)) {
            return blockedResponse(event.request);
        }
        return fetch(event.request);
    })());
});
