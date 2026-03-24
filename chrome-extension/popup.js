function fmt(mc) {
  if (!mc) return "—";
  if (mc >= 1e9) return `$${(mc/1e9).toFixed(2)}B`;
  if (mc >= 1e6) return `$${(mc/1e6).toFixed(2)}M`;
  if (mc >= 1e3) return `$${(mc/1e3).toFixed(1)}K`;
  return `$${mc}`;
}

function update() {
  chrome.storage.local.get(["botConnected","lastMcap","updateCount","lastMint"], (d) => {
    const dot = document.getElementById("dot");
    const statusText = document.getElementById("statusText");
    const hint = document.getElementById("hint");

    if (d.botConnected) {
      dot.className = "dot green";
      statusText.textContent = "Bot connected";
      hint.textContent = "Streaming market cap in real time.";
    } else {
      dot.className = "dot red";
      statusText.textContent = "Bot not running";
      hint.textContent = "Start the bot with npm run dev, then refresh this popup.";
    }

    document.getElementById("lastMcap").textContent = fmt(d.lastMcap);
    document.getElementById("updateCount").textContent = d.updateCount ?? 0;
    const mint = d.lastMint ?? "—";
    document.getElementById("token").textContent =
      mint.length > 12 ? mint.slice(0,6) + "..." + mint.slice(-4) : mint;
  });
}

update();
setInterval(update, 1000);
