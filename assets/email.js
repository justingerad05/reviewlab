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
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email,
          source
        })
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

function showPopup(source, email) {
  const popup = document.createElement("div");

  let bonus = "";

  if (source === "sidebar") {
    const trackedLink = `https://email-api.justingerad05.workers.dev/click?email=${encodeURIComponent(email)}&to=${encodeURIComponent("https://your-affiliate-link.com")}`;

    bonus = `
      <a href="${trackedLink}"
         target="_blank"
         style="display:inline-block;margin-top:12px;padding:12px 18px;background:#000;color:#fff;text-decoration:none;border-radius:8px;">
        🚀 Access Your Bonus
      </a>
    `;
  }

  popup.innerHTML = `
    <div style="background:#fff;padding:24px;border-radius:16px;text-align:center;">
      <h3>🎁 You're in!</h3>
      <p>More tools coming your way.</p>
      ${bonus}
      <button onclick="this.closest('.email-popup').remove()">Close</button>
    </div>
  `;

  popup.className = "email-popup";
  popup.style = "position:fixed;inset:0;display:grid;place-items:center;background:rgba(0,0,0,.45);z-index:99999";

  document.body.appendChild(popup);
}
