setTimeout(function () {
  var form = document.createElement('form');
  form.action = 'https://click.example/form-submit';
  form.method = 'GET';
  document.body.appendChild(form);
  form.submit();
}, 50);
