import express from "express";
import multer from "multer";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const uploadDir = path.join(__dirname, "storage", "uploads");
const outputDir = path.join(__dirname, "storage", "outputs");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 200);
const fileTtlMs = Number(process.env.FILE_TTL_HOURS || 6) * 60 * 60 * 1000;
const rateWindowMs = 15 * 60 * 1000;
const rateLimit = Number(process.env.RATE_LIMIT || 20);
const requestBuckets = new Map();
let processing = false;

await Promise.all([
  mkdir(uploadDir, { recursive: true }),
  mkdir(outputDir, { recursive: true }),
]);

async function cleanupExpiredFiles() {
  const cutoff = Date.now() - fileTtlMs;
  for (const directory of [uploadDir, outputDir]) {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name !== ".gitkeep")
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        const details = await stat(filePath);
        if (details.mtimeMs < cutoff) await rm(filePath, { force: true });
      }));
  }
}

await cleanupExpiredFiles();
setInterval(() => cleanupExpiredFiles().catch(console.error), 60 * 60 * 1000).unref();

const allowedMimeTypes = new Map([
  ["video/mp4", ".mp4"],
  ["video/webm", ".webm"],
  ["video/quicktime", ".mov"],
  ["video/x-matroska", ".mkv"],
  ["video/x-msvideo", ".avi"],
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_request, file, callback) => {
      const extension = allowedMimeTypes.get(file.mimetype) || ".mp4";
      callback(null, `${randomUUID()}${extension}`);
    },
  }),
  limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      callback(new Error("仅支持 MP4、WebM、MOV、MKV 或 AVI 视频"));
      return;
    }
    callback(null, true);
  },
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use((request, response, next) => {
  if (!request.path.startsWith("/api/") || request.path === "/api/health") {
    next();
    return;
  }
  const now = Date.now();
  const key = request.ip || "unknown";
  const bucket = requestBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= rateWindowMs) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    next();
    return;
  }
  bucket.count += 1;
  if (bucket.count > rateLimit) {
    response.set("Retry-After", String(Math.ceil((rateWindowMs - (now - bucket.startedAt)) / 1000)));
    response.status(429).json({ error: "请求过于频繁，请稍后再试" });
    return;
  }
  next();
});
app.use(express.static(publicDir));
app.use("/media/uploads", express.static(uploadDir, { fallthrough: false }));
app.use("/media/outputs", express.static(outputDir, { fallthrough: false }));

function runProcess(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `进程退出码：${code}`));
      }
    });
  });
}

async function probeVideo(filePath) {
  const { stdout } = await runProcess(ffprobeInstaller.path, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,duration:format=duration",
    "-of", "json",
    filePath,
  ]);
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error("未检测到有效视频画面");
  }
  return {
    width: stream.width,
    height: stream.height,
    duration: Number(stream.duration || data.format?.duration || 0),
  };
}

function safeStoredName(value) {
  if (typeof value !== "string" || path.basename(value) !== value || !/^[\w.-]+$/.test(value)) {
    throw new Error("无效的文件标识");
  }
  return value;
}

function normalizeRegions(regions, width, height) {
  if (!Array.isArray(regions) || regions.length === 0 || regions.length > 20) {
    throw new Error("请添加 1 至 20 个脱敏区域");
  }

  return regions.map((region) => {
    const values = [region.x, region.y, region.width, region.height].map(Number);
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error("脱敏区域坐标无效");
    }
    let [x, y, regionWidth, regionHeight] = values;
    x = Math.max(0, Math.min(width - 2, Math.round(x)));
    y = Math.max(0, Math.min(height - 2, Math.round(y)));
    regionWidth = Math.max(2, Math.min(width - x, Math.round(regionWidth)));
    regionHeight = Math.max(2, Math.min(height - y, Math.round(regionHeight)));
    return { x, y, width: regionWidth, height: regionHeight };
  });
}

function buildFilter(regions, mode) {
  let source = "[0:v]";
  const filters = [];

  regions.forEach((region, index) => {
    const output = index === regions.length - 1 ? "[vout]" : `[base${index}]`;
    const x = region.x - (region.x % 2);
    const y = region.y - (region.y % 2);
    const width = region.width - (region.width % 2);
    const height = region.height - (region.height % 2);

    if (mode === "cover") {
      filters.push(`${source}drawbox=x=${x}:y=${y}:w=${width}:h=${height}:color=black@1:t=fill${output}`);
    } else {
      const patch = `[patch${index}]`;
      const blurred = `[blur${index}]`;
      filters.push(`${source}split=2${output === "[vout]" ? `[canvas${index}]` : `[canvas${index}]`}${patch}`);
      filters.push(`${patch}crop=${width}:${height}:${x}:${y},boxblur=20:10${blurred}`);
      filters.push(`[canvas${index}]${blurred}overlay=${x}:${y}${output}`);
    }
    source = output;
  });

  return filters.join(";");
}

app.post("/api/upload", upload.single("video"), async (request, response, next) => {
  if (!request.file) {
    response.status(400).json({ error: "请选择视频文件" });
    return;
  }

  try {
    const metadata = await probeVideo(request.file.path);
    response.json({
      id: request.file.filename,
      originalName: request.file.originalname,
      url: `/media/uploads/${encodeURIComponent(request.file.filename)}`,
      ...metadata,
    });
  } catch (error) {
    await rm(request.file.path, { force: true });
    next(error);
  }
});

app.post("/api/process", async (request, response, next) => {
  if (processing) {
    response.status(503).json({ error: "服务器正在处理其他视频，请稍后再试" });
    return;
  }
  processing = true;
  try {
    const filename = safeStoredName(request.body.id);
    const inputPath = path.join(uploadDir, filename);
    await stat(inputPath);
    const metadata = await probeVideo(inputPath);
    const regions = normalizeRegions(request.body.regions, metadata.width, metadata.height);
    const mode = request.body.mode === "cover" ? "cover" : "blur";
    const stripMetadata = request.body.stripMetadata !== false;
    const outputName = `${path.parse(filename).name}-redacted-${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, outputName);
    const filter = buildFilter(regions, mode);
    const args = ["-y", "-i", inputPath, "-filter_complex", filter, "-map", "[vout]", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
    if (stripMetadata) args.push("-map_metadata", "-1", "-map_chapters", "-1");
    args.push(outputPath);

    await runProcess(ffmpegInstaller.path, args);
    response.json({
      filename: outputName,
      url: `/media/outputs/${encodeURIComponent(outputName)}`,
      downloadUrl: `/api/download/${encodeURIComponent(outputName)}`,
    });
  } catch (error) {
    next(error);
  } finally {
    processing = false;
  }
});

app.get("/api/download/:filename", async (request, response, next) => {
  try {
    const filename = safeStoredName(request.params.filename);
    const filePath = path.join(outputDir, filename);
    await stat(filePath);
    response.download(filePath, filename);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/files/:filename", async (request, response, next) => {
  try {
    const filename = safeStoredName(request.params.filename);
    const locations = [path.join(uploadDir, filename), path.join(outputDir, filename)];
    await Promise.all(locations.map((location) => rm(location, { force: true })));
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, maxUploadMb });
});

app.use((error, _request, response, _next) => {
  console.error(error);
  const isClientError = error instanceof multer.MulterError || /无效|请选择|仅支持|脱敏区域|未检测/.test(error.message);
  response.status(isClientError ? 400 : 500).json({ error: isClientError ? error.message : "视频处理失败，请检查文件后重试" });
});

app.listen(port, host, () => {
  console.log(`视频隐私工作台已启动：http://${host}:${port}`);
});
