// Envolver TODO o seu código dentro do listener `DOMContentLoaded`
document.addEventListener('DOMContentLoaded', () => {

    // Obtenha referências a todos os elementos da interface
    const portInput = document.getElementById('port');
    const baudRateInput = document.getElementById('baudRate');
    const httpPortInput = document.getElementById('httpPort');
    const pesoDiv = document.getElementById('peso');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const statusMessageDiv = document.getElementById('statusMessage');

    // --- Event Listener para o Botão INICIAR ---
    startBtn.addEventListener('click', async () => {
        const config = {
            port: portInput.value,
            baudRate: baudRateInput.value,
            httpPort: httpPortInput.value
        };

        // Feedback visual: iniciando
        statusMessageDiv.textContent = 'Iniciando balança e servidor...';
        statusMessageDiv.className = 'status-message';
        startBtn.disabled = true;
        stopBtn.disabled = true;
        portInput.disabled = true;
        baudRateInput.disabled = true;
        httpPortInput.disabled = true;

        try {
            const message = await window.electronAPI.startServer(config);
            statusMessageDiv.textContent = message;
            statusMessageDiv.className = 'status-message success';
            stopBtn.disabled = false;
        } catch (error) {
            statusMessageDiv.textContent = `Erro ao iniciar: ${error}`;
            statusMessageDiv.className = 'status-message error';
            startBtn.disabled = false;
            portInput.disabled = false;
            baudRateInput.disabled = false;
            httpPortInput.disabled = false;
        }
    });

    // --- Event Listener para o Botão PARAR ---
    stopBtn.addEventListener('click', async () => {
        // Feedback visual: parando
        statusMessageDiv.textContent = 'Parando balança e servidor...';
        statusMessageDiv.className = 'status-message';
        startBtn.disabled = true;
        stopBtn.disabled = true;

        try {
            const message = await window.electronAPI.stopServer();
            statusMessageDiv.textContent = message;
            statusMessageDiv.className = 'status-message success';
            pesoDiv.textContent = '--';
            startBtn.disabled = false;
            portInput.disabled = false;
            baudRateInput.disabled = false;
            httpPortInput.disabled = false;
        } catch (error) {
            statusMessageDiv.textContent = `Erro ao parar: ${error}`;
            statusMessageDiv.className = 'status-message error';
            stopBtn.disabled = false;
        }
    });

    // --- Listener para Atualizações de Peso do Main Process ---
    window.electronAPI.onPesoUpdate((peso) => {
        pesoDiv.textContent = peso ? `${peso}g` : '--';

        if (peso && peso > 0) {
            statusMessageDiv.textContent = 'Balança conectada e lendo peso.';
            statusMessageDiv.className = 'status-message success';
        } else if (peso === 0 && startBtn.disabled) {
            statusMessageDiv.textContent = 'Balança zerada / aguardando item.';
            statusMessageDiv.className = 'status-message';
        }
    });

    // --- Inicialização da Interface ---
    // Configura o estado inicial dos botões ao carregar a página
    stopBtn.disabled = true;
    portInput.disabled = false;
    baudRateInput.disabled = false;
    httpPortInput.disabled = false;
});