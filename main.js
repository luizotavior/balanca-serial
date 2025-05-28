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
      const rawData = data.toString().trim(); // rawData já é uma linha pelo ReadlineParser
      console.log(`[SerialPort - Main] Dados brutos recebidos: '${rawData}' (Hex: ${Buffer.from(rawData).toString('hex')})`);

      // === LÓGICA DE PARSEAMENTO PARA TOLEDO PRIX 3FIT ===
      // Formato esperado: [STX][ppppppp][iiii][ETX]
      // Exemplo no manual: [STX]0014385[ETX] para 14.385 (14kg 385g)

      // Remover STX (0x02) e ETX (0x03) se eles ainda estiverem na string
      // Eles não deveriam estar se o ReadlineParser com \r\n estiver funcionando.
      // Mas para segurança, vamos removê-los.
      let cleanData = rawData.replace(/\x02|\x03/g, ''); // Remove STX e ETX por seus códigos hexadecimais

      // Regex para validar o formato do peso e indicadores
      // Procura 7 dígitos para o peso (ppppppp) e 5 caracteres para o indicador (iiii)
      // O manual mostra 5 dígitos para pppppp no exemplo 0014385 (que tem 7),
      // e 5 caracteres para iiii (11111, 00000, SSSSS).
      // Vamos assumir que ppppppp tem 7 caracteres (5 inteiros, 2 decimais implícitos).
      const match = cleanData.match(/^(\d{7})([10S]{5})$/); // Captura 7 dígitos para peso e 5 caracteres para indicador

      if (match && match[1]) {
        const pesoRaw = match[1]; // Ex: "0014385"
        const indicador = match[2]; // Ex: "11111" ou "00000"

        // Parte inteira: primeiros 5 dígitos (ex: "00143")
        // Parte decimal: últimos 2 dígitos (ex: "85")
        const pesoInteiroStr = pesoRaw.substring(0, 5);
        const pesoDecimalStr = pesoRaw.substring(5, 7);

        // Converte para um número float em kg (ex: 14.38)
        const pesoEmKilos = parseFloat(`${parseInt(pesoInteiroStr)}.${pesoDecimalStr}`);
        // Converte para gramas (espera-se que o frontend lide com gramas)
        const pesoEmGrams = Math.round(pesoEmKilos * 1000);

        // Verifique o indicador para determinar se o peso é válido
        let pesoValido = true;
        if (indicador === '11111') {
            console.log('[SerialPort - Main] Balança indica peso instável.');
            pesoValido = false;
        } else if (indicador === '00000') {
            console.log('[SerialPort - Main] Balança indica peso negativo ou zero.');
            // Se o peso for 00000.00kg, é 0.
            if (pesoEmGrams === 0) {
                // A balança está zerada, isso é um peso válido para resetar.
            } else {
                // É um peso negativo que a balança não consegue indicar. Considerar inválido para impressão.
                pesoValido = false;
            }
        } else if (indicador === 'SSSSS') {
            console.log('[SerialPort - Main] Balança indica sobrecarga.');
            pesoValido = false;
        }

        if (pesoValido) {
            pesoAtual = pesoEmGrams.toString(); // Armazena o peso em gramas como string
            console.log(`[SerialPort - Main] Peso extraído: ${pesoEmKilos.toFixed(3)}kg -> ${pesoAtual}g`);
        } else {
            pesoAtual = ''; // Ou 0, se preferir
            console.log(`[SerialPort - Main] Peso inválido ou instável detectado (${indicador}). Peso zerado.`);
        }

      } else {
        // Se não encontrar o padrão Toledo esperado
        console.log(`[SerialPort - Main] Formato de resposta inesperado ou não-peso: '${rawData}'. Peso zerado.`);
        pesoAtual = ''; // Reseta se o formato não é o do peso
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