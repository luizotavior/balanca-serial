const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SerialPort, ReadlineParser } = require('serialport');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws'); // Importar o WebSocketServer

let mainWindow;
let expressServer = null; // Renomeado para expressServer para clareza
let wsServer = null;      // Para o servidor WebSocket
let serialPort = null;    // Renomeado para serialPort para clareza
let pesoAtual = '';
let pollIntervalId = null;

// --- Configurações que você pode querer tornar configuráveis no frontend ---
const BALANCE_POLLING_FREQUENCY_MS = 500; // Frequência para enviar ENQ para a balança
const WEIGH_IN_GRAMS_THRESHOLD = 30; // Peso mínimo em gramas para considerar válido
const WEIGHT_PRINT_MARGIN_GRAMS = 10; // Margem para reimpressão
const PRICE_PER_KILO = 72.90; // Preço para cálculo (pode vir de config/DB)
// ---

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 570,
    height: 802,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
      backgroundThrottling: false, // Tenta desativar o throttling
    },
      autoHideMenuBar: true, // Oculta a barra de menus por padrão
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

ipcMain.handle('start-server', async (_, config) => {
  const { port, baudRate, httpPort, wsPort } = config; // Adicionado wsPort aqui

  console.log(`[Main Process] Tentando iniciar serviços: Serial=${port}, BaudRate=${baudRate}, HTTP Port=${httpPort}, WS Port=${wsPort}`);

  return new Promise(async (resolve, reject) => { // Tornar a Promise async para usar await
    const parsedBaudRate = parseInt(baudRate);
    const parsedHttpPort = parseInt(httpPort);
    const parsedWsPort = parseInt(wsPort); // Parsear a porta do WebSocket

    // --- Validações de Entrada ---
    if (isNaN(parsedBaudRate) || parsedBaudRate <= 0) return reject('Erro: Baud Rate inválido.');
    if (isNaN(parsedHttpPort) || parsedHttpPort <= 0) return reject('Erro: Porta HTTP inválida.');
    if (isNaN(parsedWsPort) || parsedWsPort <= 0) return reject('Erro: Porta WebSocket inválida.');
    if (!port) return reject('Erro: Porta Serial não pode ser vazia.');

    // --- Fechar serviços anteriores se estiverem abertos ---
    if (expressServer) {
        expressServer.close(() => console.log('[Express] Servidor Express fechado antes de reabrir.'));
        expressServer = null;
    }
    if (wsServer) {
        wsServer.close(() => console.log('[WebSocket] Servidor WebSocket fechado antes de reabrir.'));
        wsServer = null;
    }
    if (serialPort && serialPort.isOpen) {
        serialPort.close(() => console.log(`[SerialPort] Porta serial ${serialPort.path} fechada antes de reabrir.`));
        serialPort = null;
    }
    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
    }
    pesoAtual = ''; // Reseta peso ao reiniciar

    // --- Iniciar Servidor Express (HTTP) ---
    const appExpress = express();
    appExpress.use(cors());

    appExpress.get('/peso', (req, res) => {
      const responseData = { data: { peso: parseInt(pesoAtual) || 0 } };
      console.log(`[Express] Requisição /peso. Retornando:`, responseData);
      res.json(responseData);
    });

    try {
        await new Promise((res, rej) => {
            expressServer = appExpress.listen(parsedHttpPort, () => {
                console.log(`[Express] Servidor Express rodando em http://localhost:${parsedHttpPort}`);
                res();
            }).on('error', rej);
        });
    } catch (err) {
        console.error(`[Express] ERRO CRÍTICO ao iniciar Express na porta ${parsedHttpPort}: ${err.message}`);
        return reject(`Erro ao iniciar servidor HTTP: ${err.message}`);
    }

    // --- Iniciar Servidor WebSocket ---
    try {
        await new Promise((res, rej) => {
            wsServer = new WebSocketServer({ port: parsedWsPort });
            wsServer.on('connection', ws => {
                console.log('[WebSocket] Cliente conectado.');
                ws.on('message', message => console.log(`[WebSocket] Mensagem recebida do cliente: ${message}`));
                ws.on('close', () => console.log('[WebSocket] Cliente desconectado.'));
                ws.on('error', error => console.error('[WebSocket] Erro no cliente:', error));
            });
            wsServer.on('error', rej);
            wsServer.on('listening', () => { // Evento 'listening' é disparado quando o servidor está pronto
                console.log(`[WebSocket] Servidor WebSocket iniciado na porta ${parsedWsPort}`);
                res();
            });
        });
    } catch (err) {
        console.error(`[WebSocket] ERRO CRÍTICO ao iniciar WebSocket na porta ${parsedWsPort}: ${err.message}`);
        if (expressServer) expressServer.close();
        return reject(`Erro ao iniciar servidor WebSocket: ${err.message}`);
    }

    // --- Iniciar Porta Serial ---
    try {
        serialPort = new SerialPort({
            path: port,
            baudRate: parsedBaudRate,
            parser: new ReadlineParser({ delimiter: '\r\n' }) // Para Toledo Prix 3Fit
        });
    } catch (err) {
        console.error(`[SerialPort] Erro ao criar SerialPort: ${err.message}`);
        if (expressServer) expressServer.close();
        if (wsServer) wsServer.close();
        return reject(`Erro ao configurar porta serial: ${err.message}`);
    }

    serialPort.on('open', () => {
      console.log(`[SerialPort] Porta ${port} aberta com sucesso!`);

      // === Polling da Balança (ENQ) ===
      const requestCommand = Buffer.from([0x05]); // ENQ (ASCII 05 H)
      pollIntervalId = setInterval(() => {
        if (serialPort && serialPort.isOpen) {
          serialPort.write(requestCommand, (err) => {
            if (err) console.error(`[SerialPort] Erro ao enviar comando ENQ: ${err.message}`);
          });
        }
      }, BALANCE_POLLING_FREQUENCY_MS); // Frequência definida acima

      // Resolve a Promise somente quando TUDO está pronto
      resolve(`Serviços iniciados: Serial em ${port}, HTTP em ${parsedHttpPort}, WS em ${parsedWsPort}`);
    });

    serialPort.on('data', (data) => {
      const rawData = data.toString().trim();
      // console.log(`[SerialPort - Main] Dados brutos recebidos: '${rawData}' (Hex: ${Buffer.from(rawData).toString('hex')})`);

      let cleanData = rawData.replace(/\x02|\x03/g, ''); // Remove STX e ETX

      const extractedWeightMatch = cleanData.match(/^(\d+)$/);

      let currentWeightInGrams = 0; // Padrão
      if (extractedWeightMatch && extractedWeightMatch[1]) {
        currentWeightInGrams = parseInt(extractedWeightMatch[1]);
        console.log(`[SerialPort - Main] Peso extraído: ${currentWeightInGrams}g`);
      } else {
        console.log(`[SerialPort - Main] Formato de resposta de peso inesperado: '${cleanData}'. Peso zerado.`);
      }

      pesoAtual = currentWeightInGrams.toString(); // Atualiza a variável para o endpoint HTTP

      // === Enviar peso via WebSocket para clientes conectados ===
      wsServer.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ data: { peso: currentWeightInGrams } })); // Envia no formato esperado pelo frontend
          }
      });
    });

    serialPort.on('error', (err) => {
      console.error(`[SerialPort] ERRO CRÍTICO na serial ${port}: ${err.message}`);
      // Lógica de fechamento em caso de erro grave
      if (expressServer) expressServer.close();
      if (wsServer) wsServer.close();
      if (pollIntervalId) clearInterval(pollIntervalId);
      reject(`Erro grave na porta serial: ${err.message}`);
    });

    serialPort.on('close', () => {
      console.log(`[SerialPort] Porta ${port} fechada.`);
      if (pollIntervalId) clearInterval(pollIntervalId);
    });
  });
});

ipcMain.handle('stop-server', () => {
  return new Promise(async (resolve, reject) => {
    let closedCount = 0;
    const totalToClose = (expressServer ? 1 : 0) + (wsServer ? 1 : 0) + (serialPort && serialPort.isOpen ? 1 : 0);

    const checkAndResolve = () => {
      if (closedCount === totalToClose) {
        console.log('[Main Process] Todos os serviços parados.');
        pesoAtual = '';
        resolve('Serviços parados com sucesso.');
      }
    };

    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
      console.log('[SerialPort] Polling parado.');
    }

    if (expressServer) {
      expressServer.close((err) => {
        if (err) console.error('[Express] Erro ao fechar servidor Express:', err);
        else console.log('[Express] Servidor Express parado.');
        expressServer = null;
        closedCount++;
        checkAndResolve();
      });
    } else { closedCount++; }

    if (wsServer) {
      wsServer.close((err) => {
        if (err) console.error('[WebSocket] Erro ao fechar servidor WebSocket:', err);
        else console.log('[WebSocket] Servidor WebSocket parado.');
        wsServer = null;
        closedCount++;
        checkAndResolve();
      });
    } else { closedCount++; }

    if (serialPort && serialPort.isOpen) {
      serialPort.close((err) => {
        if (err) console.error('[SerialPort] Erro ao fechar serial:', err);
        else console.log('[SerialPort] Porta serial fechada.');
        serialPort = null;
        closedCount++;
        checkAndResolve();
      });
    } else { closedCount++; }

    if (totalToClose === 0) checkAndResolve();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  // Garante que todos os serviços sejam fechados ao encerrar o aplicativo
  if (expressServer) expressServer.close();
  if (wsServer) wsServer.close();
  if (serialPort && serialPort.isOpen) serialPort.close();
  if (pollIntervalId) clearInterval(pollIntervalId);
});