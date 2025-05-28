// Obtenha referências a todos os elementos da interface
const portInput = document.getElementById('port');
const baudRateInput = document.getElementById('baudRate'); // Nome ajustado para consistência
const httpPortInput = document.getElementById('httpPort');
const pesoDiv = document.getElementById('peso');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusMessageDiv = document.getElementById('statusMessage'); // Novo elemento de status

// --- Event Listener para o Botão INICIAR ---
startBtn.addEventListener('click', async () => {
    const config = {
        port: portInput.value,
        baudRate: baudRateInput.value, // Use o nome correto da variável
        httpPort: httpPortInput.value
    };

    // Feedback visual: iniciando
    statusMessageDiv.textContent = 'Iniciando balança e servidor...';
    statusMessageDiv.className = 'status-message'; // Remove classes de sucesso/erro anteriores
    startBtn.disabled = true; // Desabilita o botão Iniciar
    stopBtn.disabled = true;  // Desabilita o botão Parar temporariamente
    // Desabilita campos de configuração enquanto tenta iniciar
    portInput.disabled = true;
    baudRateInput.disabled = true;
    httpPortInput.disabled = true;

    try {
        const message = await window.electronAPI.startServer(config);
        statusMessageDiv.textContent = message; // Exibe a mensagem de sucesso do main process
        statusMessageDiv.className = 'status-message success'; // Adiciona classe de sucesso
        stopBtn.disabled = false; // Habilita o botão Parar
    } catch (error) {
        statusMessageDiv.textContent = `Erro ao iniciar: ${error}`; // Exibe a mensagem de erro
        statusMessageDiv.className = 'status-message error'; // Adiciona classe de erro
        startBtn.disabled = false; // Habilita o botão Iniciar novamente para nova tentativa
        // Re-habilita campos de configuração em caso de erro
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
    startBtn.disabled = true; // Desabilita Iniciar temporariamente
    stopBtn.disabled = true;  // Desabilita o botão Parar

    try {
        const message = await window.electronAPI.stopServer();
        statusMessageDiv.textContent = message; // Exibe a mensagem de sucesso do main process
        statusMessageDiv.className = 'status-message success';
        pesoDiv.textContent = '--'; // Limpa o peso na interface
        startBtn.disabled = false; // Habilita o botão Iniciar
        // Habilita campos de configuração
        portInput.disabled = false;
        baudRateInput.disabled = false;
        httpPortInput.disabled = false;
    } catch (error) {
        statusMessageDiv.textContent = `Erro ao parar: ${error}`;
        statusMessageDiv.className = 'status-message error';
        stopBtn.disabled = false; // Se der erro ao parar, pode tentar parar de novo
    }
});

// --- Listener para Atualizações de Peso do Main Process ---
// Esta função é chamada sempre que o Main Process envia um novo peso
window.electronAPI.onPesoUpdate((peso) => {
    // console.log(`[Renderer] Peso recebido: ${peso}`); // Para depuração no console do navegador

    // Atualiza o div do peso. Use 'g' para indicar gramas, se for o caso.
    // Garanta que o peso seja um número ou string vazia para evitar 'nullg'
    pesoDiv.textContent = peso ? `${peso}g` : '--';

    // Opcional: Atualize a mensagem de status para indicar que a leitura está ativa
    if (peso && peso > 0) {
        statusMessageDiv.textContent = 'Balança conectada e lendo peso.';
        statusMessageDiv.className = 'status-message success';
    } else if (peso === 0 && startBtn.disabled) { // Se peso é zero mas servidor está ativo
        statusMessageDiv.textContent = 'Balança zerada / aguardando item.';
        statusMessageDiv.className = 'status-message';
    }
});

// --- Inicialização da Interface (Opcional) ---
// Configura o estado inicial dos botões ao carregar a página
document.addEventListener('DOMContentLoaded', () => {
    // Inicialmente, apenas o botão 'Iniciar' deve estar habilitado
    stopBtn.disabled = true;
    // Campos de input habilitados para configuração inicial
    portInput.disabled = false;
    baudRateInput.disabled = false;
    httpPortInput.disabled = false;
});