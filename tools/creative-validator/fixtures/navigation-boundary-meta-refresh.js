setTimeout(function () {
  var meta = document.createElement('meta');
  meta.httpEquiv = 'refresh';
  meta.content = '0;url=https://click.example/meta-refresh';
  document.head.appendChild(meta);
}, 50);
