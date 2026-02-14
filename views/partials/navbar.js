const btn = document.getElementById('mobile-menu-btn');
const menu = document.getElementById('mobile-menu');

if (btn && menu) {
  btn.addEventListener('click', () => {
    menu.classList.toggle('hidden');
  });
}

window.addEventListener('scroll', () => {
  const navbar = document.getElementById('navbar');
  const navContainer = document.getElementById('nav-container');
  if (!navbar || !navContainer) return;

  if (window.scrollY > 20) {
    navbar.classList.add('shadow-md', 'bg-white/90');
    navbar.classList.remove('glass-nav');
    navContainer.classList.remove('h-20');
    navContainer.classList.add('h-16');
  } else {
    navbar.classList.remove('shadow-md', 'bg-white/90');
    navbar.classList.add('glass-nav');
    navContainer.classList.add('h-20');
    navContainer.classList.remove('h-16');
  }
});
