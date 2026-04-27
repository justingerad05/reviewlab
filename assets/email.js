// assets/email.js
document.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("submit", async (e) => {
    const form = e.target.closest(".email-form");
    if (!form) return;

    e.preventDefault();

    const input = form.querySelector('input[type="email"]');
    if (!input) return;

    const email = (input.value || "").trim();
    
    const source = form.dataset.source || "homepage";
    const source = form.dataset.source || "sidebar";
    const source = form.dataset.source || "post";

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

      showPopup(source);
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

function showPopup(source) {
  const popup = document.createElement("div");
  popup.className = "email-popup";
  popup.style.position = "fixed";
  popup.style.inset = "0";
  popup.style.display = "grid";
  popup.style.placeItems = "center";
  popup.style.background = "rgba(0,0,0,.45)";
  popup.style.zIndex = "99999";

  let message = "You're in!";
  if (source === "sidebar") {
    message = "🎁 Bonus sent! Check your inbox.";
  } else if (source === "homepage") {
    message = "✅ Thanks for subscribing. Check your inbox.";
  } else if (source === "post") {
    message = "📩 Great choice. More reviews are on the way.";
  }

  popup.innerHTML = `
    <div class="popup-box" style="max-width:420px;width:calc(100% - 32px);background:#fff;border-radius:16px;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.25);text-align:center;">
      <h3 style="margin:0 0 12px;">${message}</h3>
      <p style="margin:0 0 16px;">More tools coming your way.</p>
      <button type="button" style="padding:10px 16px;border:0;border-radius:10px;cursor:pointer;"
        onclick="this.closest('.email-popup').remove()">Close</button>
    </div>
  `;

  document.body.appendChild(popup);
}
