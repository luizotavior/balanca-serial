const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SerialPort } = require('serialport');
// Se for usar o ReadlineParser, descomente a linha abaixo:
// const { ReadlineParser } = require('@serialport/parser-readline');
const express = require('express');
const cors = require('cors');

let mainWindow;
let server = null;
let serial = null;
let pesoAtual = ''; // Armazena a string do peso lido da balança

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 600,
    height: 450, // Altura ajustada para a interface
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Segurança: contextIsolation DEVE ser true para usar contextBridge.
      // nodeIntegration DEVE ser false para manter a segurança.
      contextIsolation: true,
      nodeIntegration: false,
      // devTools: Abra automaticamente para depuração durante o desenvolvimento.
      // REMOVA ou COMENTE esta linha em builds de produção para evitar que o DevTools abra.
      devTools: true,
    },
  });

  mainWindow.loadFile('index.html');

  // Abrir o DevTools (ferramentas de desenvolvedor) na janela principal.
  // Útil para depurar o renderer process e ver os console.logs do frontend.
  // Já habilitado via `devTools: true` acima, mas pode ser útil se você remover `devTools: true`.
  // mainWindow.webContents.openDevTools();
}

// Quando o aplicativo Electron estiver pronto
app.whenReady().then(() => {
  createWindow();

  // Ativar a janela quando o ícone do dock/barra de tarefas é clicado e não há janelas abertas
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
    // Validação de entrada
    const parsedBaudRate = parseInt(baudRate);
    const parsedHttpPort = parseInt(httpPort);

    if (isNaN(parsedBaudRate) || parsedBaudRate <= 0) {
      const errorMsg = 'Erro: Baud Rate inválido. Deve ser um número positivo.';
      console.error(`[Main Process] ${errorMsg}`);
      return reject(errorMsg);
    }
    if (isNaN(parsedHttpPort) || parsedHttpPort <= 0) {
      const errorMsg = 'Erro: Porta HTTP inválida. Deve ser um número positivo.';
      console.error(`[Main Process] ${errorMsg}`);
      return reject(errorMsg);
    }
    if (!port) {
        const errorMsg = 'Erro: Porta Serial não pode ser vazia.';
        console.error(`[Main Process] ${errorMsg}`);
        return reject(errorMsg);
    }

    // --- Iniciar Porta Serial ---
    // Se a porta já estiver aberta, feche antes de tentar abrir novamente
    if (serial && serial.isOpen) {
      serial.close();
      console.log(`[SerialPort] Porta serial ${serial.path} fechada antes de reabrir.`);
    }

    try {
        serial = new SerialPort({
            path: port,
            baudRate: parsedBaudRate,
            // Adicione um parser se souber o delimitador da sua balança,
            // por exemplo, para balanças que enviam dados por linha, descomente a linha abaixo:
            // parser: new ReadlineParser({ delimiter: '\n' })
        });
    } catch (err) {
        // Captura erros de inicialização da SerialPort (ex: porta não encontrada)
        console.error(`[SerialPort] Erro ao criar SerialPort: ${err.message}`);
        return reject(`Erro ao configurar porta serial: ${err.message}`);
    }

let pollIntervalId = null; // Variável para armazenar o ID do intervalo

serial.on('open', () => {
  console.log(`[SerialPort] Porta ${port} aberta com sucesso!`);
  // Enviar comando para balança a cada X milissegundos
  const pollCommand = 'P\r\n'; // Exemplo: um 'P' seguido de Carriage Return e Line Feed
  const pollFrequency = 1000; // A cada 1 segundo

  pollIntervalId = setInterval(() => {
    if (serial && serial.isOpen) {
      serial.write(pollCommand, (err) => {
        if (err) {
          console.error(`[SerialPort] Erro ao enviar comando de polling: ${err.message}`);
        } else {
          // console.log(`[SerialPort] Comando '${pollCommand.trim()}' enviado.`);
        }
      });
    }
  }, pollFrequency);
});

    serial.on('data', (data) => {
      const rawData = data.toString().trim();
      console.log(`[SerialPort - Main] Dados brutos recebidos: '${rawData}'`);

      // Lógica de extração do peso:
      // Isso é um REGEX BÁSICO para pegar números. Pode precisar de ajuste fino.
      const extractedWeightMatch = rawData.match(/\d+/);
      if (extractedWeightMatch && extractedWeightMatch[0]) {
        pesoAtual = extractedWeightMatch[0]; // Pega o primeiro número encontrado
      } else {
        pesoAtual = ''; // Reseta se não encontrar número válido
      }

      console.log(`[SerialPort - Main] Peso extraído e atualizado: '${pesoAtual}'`);

      // Envia o peso para o processo de renderização (frontend do Electron)
      mainWindow.webContents.send('peso', pesoAtual);
    });

    serial.on('error', (err) => {
      console.error(`[SerialPort] ERRO CRÍTICO na serial ${port}: ${err.message}`);
      // Se houver um erro na serial após a abertura, rejeita a promise e para o servidor
      reject(`Erro grave na porta serial: ${err.message}`);
      // Opcional: tentar fechar a porta e o servidor Express aqui se o erro for fatal.
      if (server) {
        server.close();
        server = null;
      }
    });

    serial.on('close', () => {
      console.log(`[SerialPort] Porta ${port} fechada.`);
    });

    // --- Iniciar Servidor Express ---
    const appExpress = express();

    // Configurar CORS: para permitir que o frontend do seu domínio acesse esta API.
    // Para depuração, 'cors()' permite todas as origens (pouco seguro para produção).
    // Para produção, use: `cors({ origin: 'https://pdv.clienterei.com.br' })`
    appExpress.use(cors());

    appExpress.get('/peso', (req, res) => {
      // Ajuste para o formato {"data":{"peso":X}} que o seu frontend espera
      const responseData = {
        data: {
          peso: parseInt(pesoAtual) || 0 // Garante que o peso seja um número ou 0 se vazio/inválido
        }
      };
      console.log(`[Express] Requisição /peso. Retornando:`, responseData);
      res.json(responseData);
    });

    server = appExpress.listen(parsedHttpPort, () => {
      console.log(`[Express] Servidor Express rodando em http://localhost:${parsedHttpPort}`);
      // Resolve a Promise somente quando AMBOS (SerialPort e Express) estão prontos
      resolve(`Balança conectada em ${port} e servidor HTTP em http://localhost:${parsedHttpPort}`);
    }).on('error', (err) => {
      // Captura erros na inicialização do servidor Express (ex: porta já em uso)
      console.error(`[Express] ERRO CRÍTICO ao iniciar Express na porta ${parsedHttpPort}: ${err.message}`);
      // Se der erro ao iniciar o Express, tenta fechar a serial também.
      if (serial && serial.isOpen) {
        serial.close();
        serial = null;
      }
      reject(`Erro ao iniciar servidor HTTP: ${err.message}`);
    });
  });
});

// Manipulador IPC para parar tudo
ipcMain.handle('stop-server', () => {
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
    console.log('[SerialPort] Polling parado.');
  }
  return new Promise((resolve, reject) => {
    let closedCount = 0;
    const totalToClose = (server ? 1 : 0) + (serial && serial.isOpen ? 1 : 0);

    const checkAndResolve = () => {
      if (closedCount === totalToClose) {
        console.log('[Main Process] Todos os serviços (serial e Express) parados.');
        pesoAtual = ''; // Limpa o peso ao parar
        resolve('Serviços parados com sucesso.');
      }
    };

    if (server) {
      server.close((err) => {
        if (err) {
          console.error('[Express] Erro ao fechar servidor Express:', err);
          // Não rejeita tudo por um erro de fechamento, apenas loga.
        } else {
          console.log('[Express] Servidor Express parado.');
        }
        server = null;
        closedCount++;
        checkAndResolve();
      });
    } else {
      closedCount++; // Se não havia servidor para fechar
    }

    if (serial && serial.isOpen) {
      serial.close((err) => {
        if (err) {
          console.error('[SerialPort] Erro ao fechar serial:', err);
          // Não rejeita tudo por um erro de fechamento, apenas loga.
        } else {
          console.log('[SerialPort] Porta serial fechada.');
        }
        serial = null;
        closedCount++;
        checkAndResolve();
      });
    } else {
      closedCount++; // Se não havia serial para fechar
    }

    // Se não havia nada para fechar
    if (totalToClose === 0) {
      checkAndResolve();
    }
  });
});

// Garante que o servidor Express e a porta serial sejam fechados
// quando todas as janelas do Electron forem fechadas (aplicativo encerrado).
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
});