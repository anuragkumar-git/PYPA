
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { url } = req.body || {};

    let target;

    try {
      target = new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL." });
    }

    // Restrict fetching to Digialm response-sheet URLs.
    if (
      target.protocol !== "https:" ||
      !target.pathname.includes("/touchstone/AssessmentQPHTMLMode1/")
    ) {
      return res.status(403).json({
        error: "Unsupported response-sheet URL.",
      });
    }

    const upstream = await fetch(target.toString(), {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(9000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
        Referer: `${target.origin}/`,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'no-cache',
      },
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      return res.status(502).json({
        error: "Digialm redirected the request. This URL needs additional handling.",
      });
    }

    if (!upstream.ok) {
      const errorBody = await upstream.text();

      console.error("Digialm response:", {
        status: upstream.status,
        statusText: upstream.statusText,
        body: errorBody.slice(0, 3000),
        url: target.href,
      });

      return res.status(502).json({
        error: `Digialm returned HTTP ${upstream.status}.`,
        upstreamStatus: upstream.status,
        upstreamMessage: errorBody.slice(0, 1000),
      });
    }

    const contentType = upstream.headers.get("content-type") || "";

    if (!contentType.toLowerCase().includes("text/html")) {
      return res.status(502).json({
        error: "The URL did not return an HTML page.",
      });
    }

    const html = await upstream.text();

    if (!html.trim()) {
      return res.status(502).json({
        error: "Digialm returned an empty page.",
      });
    }

    // Vercel Function response payloads are limited to 4.5 MB.
    // Keep some room for the JSON wrapper.
    if (new TextEncoder().encode(html).length > 4 * 1024 * 1024) {
      return res.status(413).json({
        error: "Response sheet is too large for this import method.",
      });
    }

    if (!html.includes("Question ID")) {
      return res.status(422).json({
        error: "The returned page does not look like a Digialm response sheet.",
      });
    }

    return res.status(200).json({
      html,
      finalUrl: upstream.url || target.href,
    });

  } catch (error) {
    console.error("Response-sheet fetch error:", error);

    return res.status(500).json({
      error: "Unable to fetch the response sheet. Please try uploading the HTML file instead.",
    });
  }
}
