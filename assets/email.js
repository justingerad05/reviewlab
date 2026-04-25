document.addEventListener("DOMContentLoaded", function(){

  document.querySelectorAll(".email-form").forEach(form => {

    form.addEventListener("submit", async function(e){
      e.preventDefault();

      const input = form.querySelector("input[type=email]");
      const email = input.value;
      const source = form.dataset.source;

      try {
        const res = await fetch("https://email-api.justingerad05.workers.dev/", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    email: email,
    source: source
  })
});

        if(!res.ok){
          throw new Error("API failed");
        }

        showPopup(source);
        input.value = "";

      } catch (err){
        console.error("Email API error:", err);
        alert("Something went wrong. Try again.");
      }
    });

  });

});

function showPopup(source){
  const popup = document.createElement("div");
  popup.className = "email-popup";

  let message = "You're in!";
  if(source === "sidebar"){
    message = "🎁 Bonus sent! Check your inbox.";
  }

  popup.innerHTML = `
    <div class="popup-box">
      <h3>${message}</h3>
      <p>More tools coming your way.</p>
      <button onclick="this.parentElement.parentElement.remove()">Close</button>
    </div>
  `;

  document.body.appendChild(popup);
}
