const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
const decode = s => String(s).replace(/&(amp|lt|gt|quot|apos|#39);/g, m => ENTITIES[m]);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "GET isteği gerekli." });
  }

  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Arama kelimesi gerekli." });

  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(500).json({ error: "YOUTUBE_API_KEY tanımlı değil." });

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("videoCategoryId", "10"); // Müzik
    url.searchParams.set("videoEmbeddable", "true");
    url.searchParams.set("maxResults", "30");
    url.searchParams.set("q", q);
    url.searchParams.set("key", key);

    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const data = await response.json();

    if (!response.ok) {
      console.error("YouTube API hatası:", data?.error?.message);
      return res.status(502).json({ error: data?.error?.message || "YouTube API hatası." });
    }

    const tracks = (data.items || [])
      .filter(x => x.id?.videoId && x.snippet?.title)
      .map(x => ({
        videoId: x.id.videoId,
        title: decode(x.snippet.title),
        author: decode(x.snippet.channelTitle || "Bilinmeyen sanatçı")
      }));

    return res.status(200).json(tracks);
  } catch (error) {
    console.error("Arama hatası:", error.message);
    return res.status(502).json({ error: "YouTube API'ye ulaşılamadı." });
  }
}
