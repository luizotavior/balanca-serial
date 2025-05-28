const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
// Importar Buffer para trabalhar com caracteres ASCII específicos
const { SerialPort, ReadlineParser } = require('serialport'); // ReadlineParser ainda é útil se cada resposta terminar com \r\n
const express = require('express');
const cors = require('cors');

let mainWindow;
let server = null;
let serial = null;
let pesoAtual = '';
let pollIntervalId = null;

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

    if (serial && serial.isOpen) {
      serial.close();
      console.log(`[SerialPort] Porta serial ${serial.path} fechada antes de reabrir.`);
    }
    if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
    }

    try {
        serial = new SerialPort({
            path: port,
            baudRate: parsedBaudRate,
            // A balança Toledo envia uma sequência, então ReadlineParser é útil.
            // O manual não especifica um delimitador \r\n na resposta, mas muitas balanças usam.
            // Se o \r\n não funcionar, você pode precisar de um parser de bytes para o STX/ETX.
            parser: new ReadlineParser({ delimiter: '\r\n' }) // Tente com \r\n, é comum mesmo se não explícito no manual.
        });
    } catch (err) {
        console.error(`[SerialPort] Erro ao criar SerialPort: ${err.message}`);
        return reject(`Erro ao configurar porta serial: ${err.message}`);
    }

    serial.on('open', () => {
      console.log(`[SerialPort] Porta ${port} aberta com sucesso!`);

      // === COMANDO DE POLLING PARA TOLEDO PRIX 3FIT ===
      // O comando para solicitar o peso é [ENQ] (ASCII 05 H).
      const requestCommand = Buffer.from([0x05]); // Cria um Buffer com o byte ENQ

      const pollingFrequency = 500; // 500ms é um bom intervalo para polling

      pollIntervalId = setInterval(() => {
        if (serial && serial.isOpen) {
          serial.write(requestCommand, (err) => {
            if (err) {
              console.error(`[SerialPort] Erro ao enviar comando ENQ: ${err.message}`);
            } else {
              // console.log(`[SerialPort] Comando ENQ (${requestCommand.toString('hex')}) enviado.`);
            }
          });
        }
      }, pollingFrequency);
    });

serial.on('data', (data) => {
  const rawData = data.toString().trim();
  console.log(`[SerialPort - Main] Dados brutos recebidos: '${rawData}' (Hex: ${Buffer.from(rawData).toString('hex')})`);

  // Toledo Prix 3Fit - Novo Parseamento para [STX]NNNNN[ETX] ou [STX]NNNNNN[ETX]
  // O Hex que você mostrou (02303032353203) é STX (02) + "00252" + ETX (03)
  // Então, a string rawData será "00252" (se o ReadlineParser já remover STX/ETX, o que é improvável)
  // Ou será '\x0200252\x03' (se o ReadlineParser estiver apenas quebrando por \r\n).

  // Primeiro, remova STX (0x02) e ETX (0x03) da string, se presentes.
  // Isso garante que só tenhamos os dígitos do peso.
  let cleanData = rawData.replace(/\x02|\x03/g, ''); // Remove STX (0x02) e ETX (0x03)

  // Agora, tente extrair os dígitos numéricos.
  // O peso "00252" sugere 3 casas decimais implícitas ou que o valor é em gramas diretamente.
  // Se 00252 significa 252 gramas, então é só converter para inteiro.
  // Se 00252 significa 0.252 kg, precisamos dividir por 1000.
  const extractedWeightMatch = cleanData.match(/^(\d+)$/); // Procura uma string que consiste APENAS de dígitos

  if (extractedWeightMatch && extractedWeightMatch[1]) {
    const pesoRaw = extractedWeightMatch[1]; // Ex: "00252"

    // --- LÓGICA DE CONVERSÃO DO PESO ---
    // A Toledo Prix geralmente envia em gramas ou com 3 casas decimais implícitas.
    // Se "00252" = 252g:
    const pesoEmGrams = parseInt(pesoRaw);
    console.log(`[SerialPort - Main] Peso extraído: ${pesoEmGrams}g (assumindo formato em gramas)`);

    // Se "00252" = 0.252 kg (252 gramas), que é o mais provável para balanças em kg
    // const pesoEmKilos = parseInt(pesoRaw) / 1000; // Ex: 0.252
    // const pesoEmGrams = Math.round(pesoEmKilos * 1000); // 252

    // Ou se 5 dígitos: 00252 -> 2.52 kg (assumindo 2 casas decimais)
    // const pesoInteiroStr = pesoRaw.substring(0, pesoRaw.length - 2);
    // const pesoDecimalStr = pesoRaw.substring(pesoRaw.length - 2);
    // const pesoEmKilos = parseFloat(`${parseInt(pesoInteiroStr)}.${pesoDecimalStr}`);
    // const pesoEmGrams = Math.round(pesoEmKilos * 1000);

    // O mais seguro para "00252" é assumir que são gramas se a balança pesa em kg com 3 casas decimais.
    // Se a balança pesa em kg com 2 casas decimais, um peso de 252g seria "000.25".

    pesoAtual = pesoEmGrams.toString(); // Armazena como string (frontend espera gramas)

  } else {
    // Se não encontrar o padrão numérico esperado
    console.log(`[SerialPort - Main] Formato de resposta de peso inesperado: '${cleanData}'. Peso zerado.`);
    pesoAtual = ''; // Ou '0'
  }

  mainWindow.webContents.send('peso', pesoAtual);
});

    serial.on('error', (err) => {
      console.error(`[SerialPort] ERRO CRÍTICO na serial ${port}: ${err.message}`);
      reject(`Erro grave na porta serial: ${err.message}`);
      if (server) {
        server.close();
        server = null;
      }
      if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
      }
    });

    serial.on('close', () => {
      console.log(`[SerialPort] Porta ${port} fechada.`);
      if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
      }
    });

    // --- Iniciar Servidor Express ---
    const appExpress = express();
    appExpress.use(cors());

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
      if (pollIntervalId) {
        clearInterval(pollIntervalId);
        pollIntervalId = null;
      }
      reject(`Erro ao iniciar servidor HTTP: ${err.message}`);
    });
  });
});

ipcMain.handle('stop-server', () => {
  return new Promise((resolve, reject) => {
    if (pollIntervalId) {
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
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
    console.log('[SerialPort] Polling parado no encerramento do app.');
  }
});