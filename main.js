const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SerialPort, ReadlineParser } = require('serialport'); // Importe ReadlineParser
const express = require('express');
const cors = require('cors');

let mainWindow;
let server = null;
let serial = null;
let pesoAtual = ''; // Armazena a string do peso lido da balança
let pollIntervalId = null; // Para o setInterval que enviará o comando 'R'

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 450,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true,
    },
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

// Manipulador IPC para iniciar o servidor e a porta serial
ipcMain.handle('start-server', async (_, config) => {
  const { port, baudRate, httpPort } = config;

  console.log(`[Main Process] Tentando iniciar servidor: Port=${port}, BaudRate=${baudRate}, HTTP Port=${httpPort}`);

  return new Promise((resolve, reject) => {
    const parsedBaudRate = parseInt(baudRate);
    const parsedHttpPort = parseInt(httpPort);

    if (isNaN(parsedBaudRate) || parsedBaudRate <= 0) {
      return reject('Erro: Baud Rate inválido. Deve ser um número positivo.');
    }
    if (isNaN(parsedHttpPort) || parsedHttpPort <= 0) {
      return reject('Erro: Porta HTTP inválida. Deve ser um número positivo.');
    }
    if (!port) {
      return reject('Erro: Porta Serial não pode ser vazia.');
    }

    // --- Iniciar Porta Serial ---
    if (serial && serial.isOpen) {
      serial.close();
      console.log(`[SerialPort] Porta serial ${serial.path} fechada antes de reabrir.`);
    }
    // Limpa o intervalo de polling anterior, se houver
    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
    }

    try {
        serial = new SerialPort({
            path: port,
            baudRate: parsedBaudRate,
            // O parser Readline é ideal para balanças que enviam o peso em uma linha seguida de \r\n
            // parser: new ReadlineParser({ delimiter: '\r\n' }) // Balanças Toledo geralmente usam \r\n
        });
    } catch (err) {
        console.error(`[SerialPort] Erro ao criar SerialPort: ${err.message}`);
        return reject(`Erro ao configurar porta serial: ${err.message}`);
    }

    serial.on('open', () => {
      console.log(`[SerialPort] Porta ${port} aberta com sucesso!`);

      // === IMPORTANTE: Enviar comando 'R' (Request Weight) para a balança ===
      // A balança Toledo Prix 3 Fit geralmente precisa de um comando para enviar o peso.
      // O comando 'R' (ASCII 82) seguido de um caractere de retorno de carro (\r) é comum.
      const requestCommand = 'R\r'; // Comando 'R' + CR

      // Define um intervalo para enviar o comando de polling
      // A frequência do polling deve ser razoável para não sobrecarregar a balança.
      // 500ms (0.5s) a 1000ms (1s) é um bom começo.
      const pollingFrequency = 500; // Milissegundos

      pollIntervalId = setInterval(() => {
        if (serial && serial.isOpen) {
          serial.write(requestCommand, (err) => {
            if (err) {
              console.error(`[SerialPort] Erro ao enviar comando de polling: ${err.message}`);
            } else {
              // console.log(`[SerialPort] Comando '${requestCommand.trim()}' enviado.`); // Logar para depuração
            }
          });
          serial.write('P\r', (err) => {
            if (err) {
              console.error(`[SerialPort] Erro ao enviar comando de polling: ${err.message}`);
            } else {
              // console.log(`[SerialPort] Comando '${requestCommand.trim()}' enviado.`); // Logar para depuração
            }
          });
          serial.write('S\r', (err) => {
            if (err) {
              console.error(`[SerialPort] Erro ao enviar comando de polling: ${err.message}`);
            } else {
              // console.log(`[SerialPort] Comando '${requestCommand.trim()}' enviado.`); // Logar para depuração
            }
          });
        }
      }, pollingFrequency);
    });

    // === IMPORTANTE: Lógica de parseamento da resposta da balança ===
    serial.on('data', (data) => {
      // Com ReadlineParser, 'data' já é uma linha terminada por \r\n
      const rawData = data.toString().trim();
      console.log(`[SerialPort - Main] Dados brutos recebidos: '${rawData}'`);

      // Exemplo de formato da Toledo Prix 3 Fit:
      // "S I 00000.00kg" (estável, positivo)
      // "U I 00000.00kg" (instável, positivo)
      // "S I 00000.00kg" (estável, zero)
      // "E 1" (erro)
      // O peso está após o 4º caractere, formatado com 5 dígitos inteiros e 2 decimais.

      // Regex para extrair o número do peso (inteiro e decimal)
      // Procura por "S I" ou "U I" seguido de 5 dígitos, um ponto, 2 dígitos e "kg".
      const match = rawData.match(/[SU] I (\d{5}\.\d{2})kg/);

      if (match && match[1]) {
        // Extrai o número formatado como "00000.00"
        const weightString = match[1];
        // Converte para gramas (multiplicando por 1000) e remove o ponto
        // Ou, se o seu frontend espera gramas, multiplique e remova o decimal.
        // Se o frontend espera "341" para 341g, e a balança envia "00000.34kg",
        // você precisa multiplicar por 1000 e converter para inteiro.
        // Ex: "00000.34" kg -> 0.34 kg * 1000 = 340 gramas
        const weightInKilos = parseFloat(weightString); // Ex: 0.34
        const weightInGrams = Math.round(weightInKilos * 1000); // Ex: 340

        pesoAtual = weightInGrams.toString(); // Armazena como string
        console.log(`[SerialPort - Main] Peso extraído: ${pesoInKilos}kg -> ${pesoAtual}g`);
      } else {
        // Se não encontrar o padrão esperado, o peso é considerado 0 ou vazio
        pesoAtual = ''; // Ou '0' se preferir manter um 0.
        console.log(`[SerialPort - Main] Formato de resposta inesperado ou peso inválido: '${rawData}'. Peso zerado.`);
      }

      // Envia o peso para o processo de renderização (frontend do Electron)
      mainWindow.webContents.send('peso', pesoAtual);
    });

    serial.on('error', (err) => {
      console.error(`[SerialPort] ERRO CRÍTICO na serial ${port}: ${err.message}`);
      reject(`Erro grave na porta serial: ${err.message}`);
      if (server) {
        server.close();
        server = null;
      }
      if (pollIntervalId) { // Limpa o polling em caso de erro grave
        clearInterval(pollIntervalId);
        pollIntervalId = null;
      }
    });

    serial.on('close', () => {
      console.log(`[SerialPort] Porta ${port} fechada.`);
      if (pollIntervalId) { // Limpa o polling quando a porta fecha
        clearInterval(pollIntervalId);
        pollIntervalId = null;
      }
    });

    // --- Iniciar Servidor Express ---
    const appExpress = express();
    appExpress.use(cors()); // Configure a origem para produção

    appExpress.get('/peso', (req, res) => {
      const responseData = {
        data: {
          peso: parseInt(pesoAtual) || 0
        }
      };
      console.log(`[Express] Requisição /peso. Retornando:`, responseData);
      res.json(responseData);
    });

    server = appExpress.listen(parsedHttpPort, () => {
      console.log(`[Express] Servidor Express rodando em http://localhost:${parsedHttpPort}`);
      resolve(`Balança conectada em ${port} e servidor HTTP em http://localhost:${parsedHttpPort}`);
    }).on('error', (err) => {
      console.error(`[Express] ERRO CRÍTICO ao iniciar Express na porta ${parsedHttpPort}: ${err.message}`);
      if (serial && serial.isOpen) {
        serial.close();
        serial = null;
      }
      if (pollIntervalId) { // Limpa o polling se o Express falhar
        clearInterval(pollIntervalId);
        pollIntervalId = null;
      }
      reject(`Erro ao iniciar servidor HTTP: ${err.message}`);
    });
  });
});

// Manipulador IPC para parar tudo
ipcMain.handle('stop-server', () => {
  return new Promise((resolve, reject) => {
    if (pollIntervalId) { // Garante que o polling seja parado ao fechar
        clearInterval(pollIntervalId);
        pollIntervalId = null;
        console.log('[SerialPort] Polling parado.');
    }

    let closedCount = 0;
    const totalToClose = (server ? 1 : 0) + (serial && serial.isOpen ? 1 : 0);

    const checkAndResolve = () => {
      if (closedCount === totalToClose) {
        console.log('[Main Process] Todos os serviços (serial e Express) parados.');
        pesoAtual = '';
        resolve('Serviços parados com sucesso.');
      }
    };

    if (server) {
      server.close((err) => {
        if (err) console.error('[Express] Erro ao fechar servidor Express:', err);
        else console.log('[Express] Servidor Express parado.');
        server = null;
        closedCount++;
        checkAndResolve();
      });
    } else {
      closedCount++;
    }

    if (serial && serial.isOpen) {
      serial.close((err) => {
        if (err) console.error('[SerialPort] Erro ao fechar serial:', err);
        else console.log('[SerialPort] Porta serial fechada.');
        serial = null;
        closedCount++;
        checkAndResolve();
      });
    } else {
      closedCount++;
    }

    if (totalToClose === 0) {
      checkAndResolve();
    }
  });
});

// Garante que os serviços sejam fechados ao encerrar o aplicativo
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  if (server) {
    server.close(() => {
      console.log('[Express] Servidor Express parado devido ao fechamento do aplicativo.');
      server = null;
    });
  }
  if (serial && serial.isOpen) {
    serial.close((err) => {
      if (err) console.error('[SerialPort] Erro ao fechar serial no encerramento do app:', err);
      else console.log('[SerialPort] Porta serial fechada devido ao fechamento do aplicativo.');
      serial = null;
    });
  }
  if (pollIntervalId) { // Limpa o polling também no encerramento do app
    clearInterval(pollIntervalId);
    pollIntervalId = null;
    console.log('[SerialPort] Polling parado no encerramento do app.');
  }
});