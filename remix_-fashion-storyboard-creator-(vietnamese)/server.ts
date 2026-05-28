import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";

dotenv.config();

async function startServer() {
  try {
    const app = express();
    const PORT = 3000;

    // Use JSON parser with large limit for base64 images
    app.use(express.json({ limit: "50mb" }));

    // CORS middleware to allow cross-origin requests from any client (especially when accessing localhost API from the web app)
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-goog-api-key");
      if (req.method === "OPTIONS") {
        return res.sendStatus(200);
      }
      next();
    });

    console.log("Starting server...");

    // API routes
    app.get("/api/health", (req, res) => {
      res.json({ status: "ok" });
    });

    app.post("/api/generate-video", async (req, res) => {
      try {
        const { prompt, base64Images, aspectRatio } = req.body;
        if (!prompt) {
          return res.status(400).json({ success: false, error: "Prompt is required" });
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          return res.status(500).json({ success: false, error: "GEMINI_API_KEY is not configured on the server." });
        }

        const ai = new GoogleGenAI({ apiKey });

        // Ensure aspect ratio is valid in Veo
        // Supported: "16:9" or "9:16"
        let aspect: "16:9" | "9:16" = "9:16";
        if (aspectRatio === "16:9") {
          aspect = "16:9";
        }

        // Set up the image if base64Images are provided
        let imageParam: any = undefined;
        if (base64Images && base64Images.length > 0) {
          let cleanBase64 = base64Images[0];
          if (cleanBase64.includes(",")) {
            cleanBase64 = cleanBase64.split(",")[1];
          }
          imageParam = {
            imageBytes: cleanBase64,
            mimeType: "image/png"
          };
        }

        console.log(`Starting video generation with prompt: "${prompt}" and aspect ratio: "${aspect}"`);

        const operation = await ai.models.generateVideos({
          model: "veo-3.1-lite-generate-preview",
          prompt: prompt,
          image: imageParam,
          config: {
            numberOfVideos: 1,
            resolution: "720p",
            aspectRatio: aspect
          }
        });

        console.log(`Waiting for video operation: ${operation.name}`);

        // Poll the operation
        let op = operation;
        let attempts = 0;
        const maxAttempts = 36; // 36 * 5s = 180 seconds (3 minutes)

        while (!op.done && attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          op = await ai.operations.getVideosOperation({ operation: op });
          attempts++;
          console.log(`Polling attempt ${attempts}/${maxAttempts}: ${op.done ? 'Done' : 'In Progress'}`);
        }

        if (!op.done) {
          throw new Error("Video generation timed out on the server.");
        }

        const uri = op.response?.generatedVideos?.[0]?.video?.uri;
        if (!uri) {
          throw new Error("No video output URI returned from Gemini API.");
        }

        console.log(`Downloading video from URI: ${uri}`);

        // Do NOT send the API key header when fetching the Google Cloud Storage signed URL.
        // GCS presigned URLs will fail with SignatureDoesNotMatch if extra authorization headers are sent.
        const videoRes = await fetch(uri);

        if (!videoRes.ok) {
          throw new Error(`Failed to download video from URI. Status: ${videoRes.status}`);
        }

        const arrayBuffer = await videoRes.arrayBuffer();
        const videoBase64 = Buffer.from(arrayBuffer).toString('base64');

        console.log(`Successfully generated and downloaded video, size: ${videoBase64.length} bytes`);

        res.json({
          success: true,
          video: {
            base64: videoBase64
          }
        });

      } catch (error: any) {
        console.error("Error generating video:", error);
        res.status(500).json({ success: false, error: error.message || "Failed to generate video" });
      }
    });

    // Vite middleware for development
    if (process.env.NODE_ENV !== "production") {
      console.log("Development mode: starting Vite middleware");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } else {
      console.log("Production mode: serving static files");
      const distPath = path.join(process.cwd(), 'dist');
      
      // Serve static files
      app.use(express.static(distPath));
      
      // SPA Fallback
      app.get('*', (req, res) => {
        const indexPath = path.join(distPath, 'index.html');
        res.sendFile(indexPath);
      });
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server is listening on 0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
