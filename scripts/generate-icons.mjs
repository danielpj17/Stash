import sharp from "sharp";
import { readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgPath = join(__dirname, "../app/icon.svg");
const outputDir = join(__dirname, "../public/icons");

mkdirSync(outputDir, { recursive: true });

const sizes = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "apple-touch-icon.png", size: 180 },
];

const svgContent = readFileSync(svgPath);

for (const { name, size } of sizes) {
  await sharp(svgContent)
    .resize(size, size)
    .flatten({ background: "#282828" })
    .png()
    .toFile(join(outputDir, name));
  console.log(`Generated public/icons/${name}`);
}

console.log("Done.");
