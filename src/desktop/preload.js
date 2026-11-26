const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getDefaultPath: () => ipcRenderer.invoke('get-default-path'),
  getPlatforms: () => ipcRenderer.invoke('get-platforms'),
  selectCookiesFile: () => ipcRenderer.invoke('select-cookies-file'),
  selectCourseJson: () => ipcRenderer.invoke('select-course-json'),
  parseCourseJson: (filePath) => ipcRenderer.invoke('parse-course-json', filePath),
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  findCookiesFile: (data) => ipcRenderer.invoke('find-cookies-file', data),
  openCookiesFolder: () => ipcRenderer.invoke('open-cookies-folder'),
  startArchive: (config) => ipcRenderer.send('start-archive', config),
  startFromJson: (config) => ipcRenderer.send('start-from-json', config),
  onLog: (callback) => ipcRenderer.on('archive-log', (event, data) => callback(data)),
  onProgress: (callback) => ipcRenderer.on('archive-progress', (event, percent) => callback(percent)),
  onStatus: (callback) => ipcRenderer.on('archive-status', (event, data) => callback(data)),
  onComplete: (callback) => ipcRenderer.on('archive-complete', (event, status) => callback(status)),
  onPrompt: (callback) => ipcRenderer.on('archive-prompt', (event, question) => callback(question)),
  sendPromptInput: (input) => {
    ipcRenderer.send('send-prompt-input', input);
    ipcRenderer.send('archive-prompt-response', input);
  },
  cancelArchive: () => ipcRenderer.send('cancel-archive'),
  cancelBatchDownload: () => ipcRenderer.invoke('cancel-batch-download'),
  openPath: (targetPath) => ipcRenderer.invoke('open-path', targetPath),
  runBatchDownload: (batPath) => ipcRenderer.invoke('run-batch-download', batPath),
  removeListeners: () => {
    ipcRenderer.removeAllListeners('archive-log');
    ipcRenderer.removeAllListeners('archive-progress');
    ipcRenderer.removeAllListeners('archive-complete');
    ipcRenderer.removeAllListeners('archive-prompt');
    ipcRenderer.removeAllListeners('archive-status');
  }
});
