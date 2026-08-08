if (window.location.protocol === 'file:') {
  window.location.replace(`http://127.0.0.1:4173/${window.location.hash}`);
}
