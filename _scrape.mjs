import puppeteer from "puppeteer-core";
import fs from "node:fs";

const URL = "https://flyelep.cn";
const PATHS = ["/", "/agent/inspiration", "/agent/posterGeneration", "/agent/detailPage"];

async function main(){
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setViewport({width: 1440, height: 900});

  const allText = {};
  for(const path of PATHS){
    const url = URL + path;
    console.log("=== visiting", url);
    try{
      await page.goto(url, {waitUntil:"networkidle2", timeout:30000});
    } catch(e){
      console.log("  goto err:", e.message);
    }
    await new Promise(r=>setTimeout(r,3000));
    const data = await page.evaluate(()=>{
      const txt = document.body.innerText;
      const imgs = Array.from(document.querySelectorAll("img")).map(i=>({src:i.src, alt:i.alt})).filter(x=>x.src);
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4")).map(h=>({tag:h.tagName, text:h.innerText.trim()}));
      const buttons = Array.from(document.querySelectorAll("button, a.btn, [class*=button]")).map(b=>b.innerText.trim()).filter(t=>t && t.length<60).slice(0,30);
      return {title: document.title, txt: txt.slice(0, 5000), imgs, headings, buttons};
    });
    allText[path] = data;
    console.log("  title:", data.title);
    console.log("  headings:", data.headings.length, "imgs:", data.imgs.length);
  }
  fs.writeFileSync("_scrape-result.json", JSON.stringify(allText, null, 2));
  console.log("=== saved _scrape-result.json");
  await browser.close();
}
main().catch(e=>{console.error("FATAL:", e.message); process.exit(1);});
