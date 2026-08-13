// assets/email.js
document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("submit", async (e) => {
    const form = e.target.closest(".email-form");
    if (!form) return;

    e.preventDefault();

    const input = form.querySelector('input[type="email"]');
    if (!input) return;

    const email = (input.value || "").trim();
    const source = form.dataset.source?.trim().toLowerCase() || "unknown";

    if (!email) {
      alert("Please enter your email.");
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    const originalLabel = submitButton ? submitButton.textContent : "";

    try {
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.textContent = "Sending...";
      }

      const res = await fetch("https://email-api.justingerad05.workers.dev/", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ email, source })
      });

      const text = await res.text();
      console.log("API RESPONSE:", text);

      if (!res.ok) {
        console.error("FULL ERROR:", text);
        alert(text || "API error");
        return;
      }

      showPopup(source, email);
      input.value = "";
    } catch (err) {
      console.error("Email API error:", err);
      alert("Something went wrong. Try again.");
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel || "Submit";
      }
    }
  });
});

function getRotatingReviewTarget() {
  const pool = window.REVIEWLAB_CTA_POOLS?.reviews || [];
  if (!pool.length) return null;

  const seed = Array.from(location.pathname)
    .reduce((n, ch) => n + ch.charCodeAt(0), 0);

  return pool[seed % pool.length] || pool[0];
}

function escapePopupHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showPopup(source, email) {
  const popup = document.createElement("div");

  let title = "📩 Great choice!";
  let message = "More tools coming your way.";
  let bonus = "";

  if (source === "sidebar") {
    const trackedLink =
      `https://email-api.justingerad05.workers.dev/click?email=${encodeURIComponent(email)}&to=${encodeURIComponent("https://drive.google.com/file/d/1SH64kCm8iRY879UjUYiE3iCMDqc3TNMP/view?usp=sharing")}`;

    title = "📩 Great choice! 🎁 Here's your bonus";

    bonus = `
      <a href="${trackedLink}"
         target="_blank"
         rel="noopener"
         style="display:inline-block;margin-top:12px;padding:12px 18px;background:#000;color:#fff;text-decoration:none;border-radius:8px;">
        🚀 Access Your Bonus
      </a>
    `;
  }

  const reviewTarget = getRotatingReviewTarget();

  const reviewCta = reviewTarget ? `
    <a href="${reviewTarget.url}"
       style="display:inline-block;margin-top:12px;padding:12px 18px;background:#2563eb;color:#fff;text-decoration:none;border-radius:8px;">
      🔎 Explore ${escapePopupHtml(reviewTarget.title)} →
    </a>
  ` : "";

  popup.innerHTML = `
    <div class="popup-box" style="max-width:420px;width:calc(100% - 32px);background:#fff;border-radius:16px;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.25);text-align:center;">
      <h3 style="margin:0 0 12px;">${title}</h3>
      <p style="margin:0 0 16px;">${message}</p>
      ${bonus}
      ${reviewCta}
      <button type="button"
        style="margin-top:16px;padding:10px 16px;border:0;border-radius:10px;cursor:pointer;"
        onclick="this.closest('.email-popup').remove()">
        Close
      </button>
    </div>
  `;

  popup.className = "email-popup";
  popup.style.cssText =
    "position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.45);z-index:99999";

  popup.addEventListener("click", (e) => {
    if (e.target === popup) popup.remove();
  });

  document.body.appendChild(popup);
}
