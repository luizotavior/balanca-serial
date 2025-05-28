const portInput = document.getElementById('port');
const baudInput = document.getElementById('baudRate');
const httpInput = document.getElementById('httpPort');
const pesoDiv = document.getElementById('peso');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

startBtn.addEventListener('click', async () => {
  const config = {
    port: portInput.value,
    baudRate: baudInput.value,
    httpPort: httpInput.value
  };
  try {
    const msg = await window.electronAPI.startServer(config);
    alert(msg);
  } catch (err) {
    alert('Erro: ' + err);
  }
});

stopBtn.addEventListener('click', async () => {
  const msg = await window.electronAPI.stopServer();
  alert(msg);
});

window.electronAPI.onPesoUpdate((peso) => {
  pesoDiv.textContent = peso;
});
