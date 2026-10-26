const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
const ipc = require('./ipc');

app.commandLine.appendSwitch('lang', 'zh-CN');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let win = null;

  function createWindow() {
    win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 1080,
      minHeight: 700,
      backgroundColor: '#0f1115',
      title: 'KMCL 我的世界启动器',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
      autoHideMenuBar: true,
      show: false,
      // 去掉系统标题栏与顶部白边，改为自绘标题栏；thickFrame 保留窗口可调整大小的边缘
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    Menu.setApplicationMenu(null);
    ipc.setWindow(win);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());
    win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
    win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));
    win.on('closed', () => {
      win = null;
    });
  }

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    ipc.registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

process.on('uncaughtException', (err) => {
  console.error('主进程异常', err);
});
process.on('unhandledRejection', (err) => {
  console.error('主进程未处理的 Promise 异常', err);
});
