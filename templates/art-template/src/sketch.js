/**
 * Default p5 sketch — replace with your own work.
 *
 * Rules:
 *   - Read randomness only via $ga.rand(). Calling Math.random() makes your
 *     piece non-deterministic and the validator will fail.
 *   - Set $ga.features before the first frame so on-chain metadata is correct.
 *   - Call $ga.preview() once your composition is visually stable.
 */
const palette = ["#f72585", "#7209b7", "#3a0ca3", "#4361ee", "#4cc9f0"];
const bg = palette[Math.floor($ga.rand() * palette.length)];
const stroke = palette[Math.floor($ga.rand() * palette.length)];
const density = 80 + Math.floor($ga.rand() * 240);

$ga.features = { palette: bg, stroke, density };

function setup() {
  createCanvas(windowWidth, windowHeight).parent("stage");
  noLoop();
}

function draw() {
  background(bg);
  noFill();
  strokeWeight(1.5);
  stroke(stroke);
  for (let i = 0; i < density; i++) {
    const x = $ga.rand() * width;
    const y = $ga.rand() * height;
    const r = 10 + $ga.rand() * 220;
    ellipse(x, y, r, r);
  }
  $ga.preview();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  redraw();
}
