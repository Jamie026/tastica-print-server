const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("tastica", {
    onLog: callback => ipcRenderer.on("log", (_, data) => callback(data)),
    onEstado: callback => ipcRenderer.on("estado", (_, estado) => callback(estado)),
    guardarSede: id_sede => ipcRenderer.invoke("guardar-sede", id_sede),
    leerConfig: () => ipcRenderer.invoke("leer-config")
});
