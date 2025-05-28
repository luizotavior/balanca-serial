const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SerialPort } = require('serialport');
const express = require('express');

let mainWindow;
let server = null;
let serial = null;
let pesoAtual = ''; // Guarda a string do peso lido da balança

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // As duas linhas a seguir são CRUCIAIS para que contextBridge funcione
      contextIsolation: true, // DEVE ser true para usar contextBridge
      nodeIntegration: false, // DEVE ser false para manter a segurança com contextIsolation
      // As linhas abaixo são para depuração, remova em produção se quiser
      openDevTools: true // Se quiser que as ferramentas de desenvolvedor abram automaticamente
    },
  });

  mainWindow.loadFile('index.html');
  // Abre as ferramentas de desenvolvedor automaticamente para ver logs:
  mainWindow.webContents.openDevTools();
}

app.whenReady().then(createWindow);

// Iniciar servidor e porta serial
ipcMain.handle('start-server', async (_, config) => {
  const { port, baudRate, httpPort } = config;

  console.log(`[Main Process] Tentando iniciar servidor com: Port=${port}, BaudRate=${baudRate}, HTTP Port=${httpPort}`);

  return new Promise((resolve, reject) => {
    // Validação básica para garantir que as configurações são números válidos
    const parsedBaudRate = parseInt(baudRate);
    if (isNaN(parsedBaudRate)) {
      reject('Erro: Baud Rate inválido. Deve ser um número.');
      return;
    }

    // Inicia porta serial
    serial = new SerialPort({
      path: port,
      baudRate: parsedBaudRate,
      // Se sua balança envia dados terminados por quebra de linha, um parser Readline pode ajudar.
      // Caso contrário, você terá que analisar a string de dados brutos manualmente.
      // parser: new ReadlineParser({ delimiter: '\n' })
    });

    serial.on('open', () => {
      console.log(`[SerialPort] Porta ${port} aberta com sucesso!`);
    });

    serial.on('data', (data) => {
      const rawData = data.toString().trim(); // Começa com trim para remover espaços em branco nas extremidades

      console.log(`[SerialPort] Dados brutos recebidos: '${rawData}'`);

      // TODO: Implemente a lógica de parseamento específica para o protocolo da sua balança.
      // Por exemplo, se a balança envia "STX 000500g ETX CR LF", você precisaria extrair "000500".
      // Por enquanto, vamos assumir que 'rawData' já é o número do peso ou um número simples.
      
      // Tenta extrair apenas números da string, ignorando letras como 'g'
      const extractedWeight = rawData.match(/\d+/);
      if (extractedWeight && extractedWeight[0]) {
        pesoAtual = extractedWeight[0];
      } else {
        pesoAtual = ''; // Se não encontrar número, reseta o peso
      }
      
      console.log(`[SerialPort] Peso extraído e atualizado: '${pesoAtual}'`);
      
      // Envia o peso para o processo de renderização (frontend do Electron)
      
      mainWindow.webContents.send('peso', pesoAtual);
    });

    serial.on('error', (err) => {
      console.error(`[SerialPort] ERRO CRÍTICO na serial ${port}: ${err.message}`);
      reject(`Erro na serial: ${err.message}`);
    });

    serial.on('close', () => {
      console.log(`[SerialPort] Porta ${port} fechada.`);
    });

    // Inicia servidor Express
    const appExpress = express();
    
    // Habilitar CORS para permitir requisições de diferentes origens (especialmente do seu domínio https://pdv.clienterei.com.br)
    // Você pode instalar 'cors': npm install cors
    const cors = require('cors');
    appExpress.use(cors()); // Permite todas as origens por padrão para testes. Para produção, configure origins específicos.
    // Exemplo para produção: appExpress.use(cors({ origin: 'https://pdv.clienterei.com.br' }));

    appExpress.get('/peso', (req, res) => {
      // Ajuste para o formato {"data":{"peso":X}}
      const responseData = {
        data: {
          peso: parseInt(pesoAtual) || 0 // Garante que o peso seja um número ou 0 se vazio/inválido
        }
      };
      console.log(`[Express] Requisição /peso. Retornando:`, responseData);
      res.json(responseData);
    });

    server = appExpress.listen(httpPort, () => {
      console.log(`[Express] Servidor rodando em http://localhost:${httpPort}`);
      resolve(`Servidor rodando em http://localhost:${httpPort}`);
    }).on('error', (err) => {
      console.error(`[Express] ERRO CRÍTICO ao iniciar Express na porta ${httpPort}: ${err.message}`);
      reject(`Erro ao iniciar servidor HTTP: ${err.message}`);
    });
  });
});

// Parar tudo
ipcMain.handle('stop-server', () => {
  if (server) {
    server.close(() => {
      console.log('[Express] Servidor Express parado.');
    });
  }
  if (serial && serial.isOpen) {
    serial.close((err) => {
      if (err) console.error('[SerialPort] Erro ao fechar serial:', err);
      else console.log('[SerialPort] Porta serial fechada.');
    });
  }
  pesoAtual = '';
  return 'Servidor parado.';
});

// Garante que o servidor Express seja fechado quando o Electron for fechado
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  if (server) {
    server.close();
    server = null;
  }
  if (serial && serial.isOpen) {
    serial.close();
    serial = null;
  }
});

// Adicione um evento para reativar a janela se o ícone do dock/barra de tarefas for clicado e não houver janelas abertas
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});