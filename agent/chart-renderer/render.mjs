import { init } from "echarts";
import { Resvg } from "@resvg/resvg-js";
import { renderSVG } from "./svg.mjs";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16 * 1024 * 1024) throw Error("Chart input too large");
}
const spec = JSON.parse(input);
const svg = renderSVG(spec, false, init);
const png = new Resvg(svg, {
  font: { loadSystemFonts: true, defaultFontFamily: spec.font },
  fitTo: { mode: "width", value: 1440 },
})
  .render()
  .asPng();
process.stdout.write(JSON.stringify({ svg, png: png.toString("base64") }));
