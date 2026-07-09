const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = __dirname;
const port = 4174;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const browserPaths = [
  process.env.BROWSER_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.resolve(root, `.${decodeURIComponent(requestedPath)}`);
    const relativePath = path.relative(root, filePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      response.writeHead(200, {
        "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(data);
    });
  });
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  const executablePath = browserPaths.find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  const klines = Array.from({ length: 30 }, (_, index) => {
    const day = String(index + 1).padStart(2, "0");
    const close = 1000 + index * 5;
    return `2026-04-${day},${close - 8},${close},${close + 12},${close - 18},${100000 + index},${200000000 + index},1.20,0.50,5.00,2.10`;
  });

  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("https://push2his.eastmoney.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        data: {
          code: "688256",
          name: "寒武纪",
          market: 1,
          klines,
        },
      }),
    });
  });

  try {
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("text=寒武纪", { timeout: 30000 }).catch(async (error) => {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      throw new Error(`${error.message}\nBody: ${bodyText}\nConsole: ${errors.join(" | ")}`);
    });
    await page.waitForSelector(".middle-cell", { timeout: 30000 }).catch(async (error) => {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      throw new Error(`${error.message}\nBody: ${bodyText}\nConsole: ${errors.join(" | ")}`);
    });
    await page.screenshot({ path: path.join(root, "preview.png"), fullPage: true });

    const result = await page.evaluate(() => ({
      title: document.title,
      heading: document.querySelector("h2")?.textContent,
      stats: [...document.querySelectorAll(".stat strong")].map((node) => node.textContent),
      tableRows: document.querySelectorAll("tbody tr").length,
      error: document.querySelector(".error")?.textContent || "",
    }));

    if (errors.length) {
      throw new Error(`Console errors: ${errors.join(" | ")}`);
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
