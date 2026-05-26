const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getServerInfo: () => ipcRenderer.invoke('get-server-info'),
  getFileList: () => ipcRenderer.invoke('get-file-list'),
  deleteFile: (filename) => ipcRenderer.invoke('delete-file', filename),
  onFileListUpdated: (callback) => {
    ipcRenderer.on('file-list-updated', (event, files) => callback(files));
  },
  onWsClientCount: (callback) => {
    ipcRenderer.on('ws-client-count', (event, count) => callback(count));
  },
});
