document.addEventListener('DOMContentLoaded', () => {
    
    // -- Dashboard Chart --
    const ctx = document.getElementById('orderChart');
    if(ctx) {
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                datasets: [{
                    label: 'Orders',
                    data: [12, 19, 3, 5, 2, 3, 10],
                    borderColor: '#38bdf8',
                    backgroundColor: 'rgba(56, 189, 248, 0.1)',
                    tension: 0.4,
                    fill: true
                }]
            },
            options: {
                plugins: { legend: { display: false } },
                scales: { 
                    x: { display: false }, 
                    y: { display: false } 
                },
                responsive: true
            }
        });
    }

    // -- Order Page Logic --
    const catSelect = document.getElementById('categorySelect');
    const servSelect = document.getElementById('serviceSelect');
    
    if (catSelect && typeof servicesData !== 'undefined') {
        
        function updateServices() {
            const cat = catSelect.value;
            const filtered = servicesData.filter(s => s.category === cat);
            
            servSelect.innerHTML = filtered.map(s => 
                `<option value="${s.id}" data-rate="${s.rate}" data-min="${s.min}" data-max="${s.max}">
                    ${s.id} - ${s.name} - $${s.rate.toFixed(2)}/1k
                </option>`
            ).join('');
            
            updateCalculation();
        }

        function updateCalculation() {
            const selected = servSelect.options[servSelect.selectedIndex];
            if(!selected) return;
            
            const rate = parseFloat(selected.getAttribute('data-rate'));
            const min = selected.getAttribute('data-min');
            const max = selected.getAttribute('data-max');
            const qty = document.getElementById('quantity').value || 0;
            
            document.getElementById('servicePrice').innerText = `$${rate.toFixed(2)} / 1000`;
            document.getElementById('minMax').innerText = `Min: ${min} - Max: ${max}`;
            document.getElementById('summaryQty').innerText = qty;
            
            const total = (rate / 1000) * qty;
            document.getElementById('totalCharge').innerText = `$${total.toFixed(2)}`;
        }

        catSelect.addEventListener('change', updateServices);
        servSelect.addEventListener('change', updateCalculation);
        document.getElementById('quantity').addEventListener('input', updateCalculation);
        
        // Init
        updateServices();

        // AJAX Order Submission
        document.getElementById('orderForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('button');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="ph ph-spinner animate-spin"></i> Processing...';
            btn.disabled = true;

            const data = {
                service_id: servSelect.value,
                link: document.getElementById('link').value,
                quantity: document.getElementById('quantity').value
            };

            const res = await fetch('/order/place', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            const result = await res.json();

            if(result.status === 'success') {
                alert(result.message); // Replace with nice toast in production
                window.location.href = '/orders';
            } else {
                alert('Error: ' + result.message);
                btn.innerHTML = originalText;
                btn.disabled = false;
            }

document.addEventListener("DOMContentLoaded", () => {
  const tabLogin = document.getElementById("tab-login");
  const tabSignup = document.getElementById("tab-signup");

  const formLogin = document.getElementById("form-login");
  const formSignup = document.getElementById("form-signup");

  if (tabLogin && tabSignup && formLogin && formSignup) {
    tabLogin.addEventListener("click", () => {
      tabLogin.classList.add("active");
      tabSignup.classList.remove("active");

      formLogin.classList.remove("hidden");
      formSignup.classList.add("hidden");
    });

    tabSignup.addEventListener("click", () => {
      tabSignup.classList.add("active");
      tabLogin.classList.remove("active");

      formSignup.classList.remove("hidden");
      formLogin.classList.add("hidden");
    });
  }
});


        });
    }
});

document.addEventListener("DOMContentLoaded", () => {
  const tabLogin = document.getElementById("tab-login");
  const tabSignup = document.getElementById("tab-signup");
  const formLogin = document.getElementById("form-login");
  const formSignup = document.getElementById("form-signup");

  if(tabLogin && tabSignup && formLogin && formSignup){
    tabLogin.addEventListener("click", () => {
      tabLogin.classList.add("active");
      tabSignup.classList.remove("active");
      formLogin.classList.remove("hidden");
      formSignup.classList.add("hidden");
    });

    tabSignup.addEventListener("click", () => {
      tabSignup.classList.add("active");
      tabLogin.classList.remove("active");
      formSignup.classList.remove("hidden");
      formLogin.classList.add("hidden");
    });
  }
});


document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("mobile-menu-btn");
  const menu = document.getElementById("mobile-menu");

  if (btn && menu) {
    btn.addEventListener("click", () => {
      menu.classList.toggle("hidden");
    });

    // close menu on any link click
    const links = menu.querySelectorAll("a");
    links.forEach(link => {
      link.addEventListener("click", () => {
        menu.classList.add("hidden");
      });
    });
  }
});

window.addEventListener("load", () => {
  const landingLoader = document.getElementById("landing-loader");
  if (landingLoader) {
    landingLoader.style.opacity = "0";
    setTimeout(() => landingLoader.remove(), 300);
  }
});
