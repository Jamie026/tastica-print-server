const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const escpos = require("escpos");
escpos.Network = require("escpos-network");
const { SerialPort } = require("serialport");

const CONFIG_FILE = path.join(app.getPath("userData"), "config_tastica.json");
const API_URL = "https://servidor-356lq.ondigitalocean.app";
const PUERTO_IMPRESORA = 9100;

let mainWindow = null;
let agenteLoop = null;
let buscando = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 780,
        height: 540,
        resizable: false,
        title: "Tastica Print Agent",
        icon: path.join(__dirname, "assets", "icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        },
        backgroundColor: "#0f0f13",
        show: false
    });

    mainWindow.loadFile("renderer.html");
    mainWindow.setMenuBarVisibility(false);

    mainWindow.once("ready-to-show", function () {
        mainWindow.show();
        iniciarAgente();
    });

    mainWindow.on("closed", function () {
        mainWindow = null;
        if (agenteLoop) clearInterval(agenteLoop);
        app.quit();
    });
}

app.whenReady().then(function () {
    if (process.platform === "linux") {
        app.commandLine.appendSwitch("no-sandbox");
    }
    createWindow();
});

app.on("window-all-closed", function () {
    app.quit();
});

function sendLog(tipo, mensaje) {
    if (mainWindow) {
        mainWindow.webContents.send("log", {
            tipo: tipo,
            mensaje: mensaje,
            hora: new Date().toLocaleTimeString()
        });
    }
}

function sendEstado(estado) {
    if (mainWindow) {
        mainWindow.webContents.send("estado", estado);
    }
}

ipcMain.handle("guardar-sede", async function (_, id_sede) {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ id_sede: id_sede }, null, 4));
        sendLog("ok", "Sede guardada: " + id_sede);
        if (agenteLoop) clearInterval(agenteLoop);
        arrancarBucle(id_sede);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

ipcMain.handle("leer-config", async function () {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
            return data;
        }
        return null;
    } catch (e) {
        return null;
    }
});

async function iniciarAgente() {
    sendEstado("iniciando");
    sendLog("info", "Iniciando Tastica Print Agent...");

    if (fs.existsSync(CONFIG_FILE)) {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
            sendLog("ok", "Sede cargada: " + config.id_sede);
            arrancarBucle(config.id_sede);
        } catch (e) {
            sendLog("error", "Error leyendo configuracion: " + e.message);
            sendEstado("error");
        }
    } else {
        sendEstado("sin-configurar");
        sendLog("warn", "No hay sede configurada. Ingresa tu ID de Seguridad.");
    }
}

function arrancarBucle(id_sede) {
    sendEstado("conectado");
    sendLog("ok", "Agente activo. Escuchando comandas cada 5s...");

    agenteLoop = setInterval(async function () {
        if (buscando) return;
        buscando = true;

        try {
            let configImpresoras = {};
            try {
                const resConfig = await axios.get(API_URL + "/sedes/config-impresion/" + id_sede);
                configImpresoras = resConfig.data.impresoras || {};
            } catch (e) {
                sendLog(
                    "warn",
                    "No se pudo obtener config de impresoras: " +
                        (e.response?.status + ": " + e.message)
                );
            }

            const resMesas = await axios
                .get(API_URL + "/pedidos-linea/impresion-pendiente/" + id_sede)
                .catch(function () {
                    return { data: [] };
                });
            const resDeliveries = await axios
                .get(API_URL + "/deliveries/impresion-pendiente/" + id_sede)
                .catch(function () {
                    return { data: [] };
                });

            const mesas = resMesas.data;
            const deliveries = resDeliveries.data;

            if (mesas.length > 0 || deliveries.length > 0) {
                sendLog(
                    "info",
                    "Procesando: " +
                        mesas.length +
                        " mesa(s), " +
                        deliveries.length +
                        " delivery(s)"
                );
            }

            if (mesas.length > 0)
                await procesarPedidosArray(mesas, configImpresoras, "MESA", id_sede);
            if (deliveries.length > 0)
                await procesarPedidosArray(deliveries, configImpresoras, "DELIVERY", id_sede);
        } catch (error) {
            sendLog("error", "Error en bucle: " + error.message);
        } finally {
            buscando = false;
        }
    }, 5000);
}

async function procesarPedidosArray(pedidosArray, configImpresoras, tipo, id_sede) {
    for (const pedido of pedidosArray) {
        let datosImprimir;

        if (tipo === "MESA") {
            const pendientes =
                typeof pedido.pedidos_por_imprimir === "string"
                    ? JSON.parse(pedido.pedidos_por_imprimir || "[]")
                    : pedido.pedidos_por_imprimir || [];
            datosImprimir = pendientes.length > 0 ? pendientes : pedido.pedidos;
        } else {
            datosImprimir = pedido.pedidos;
        }

        const items = typeof datosImprimir === "string" ? JSON.parse(datosImprimir) : datosImprimir;
        const grupos = {};

        items.forEach(function (p) {
            const cat = p.categoria || "Otros";
            if (!grupos[cat]) grupos[cat] = [];
            grupos[cat].push(p);
        });

        let exitoGeneral = true;

        for (const categoria of Object.keys(grupos)) {
            const itemsCat = grupos[categoria];
            const impresoraInfo = configImpresoras[categoria];

            if (!impresoraInfo) {
                sendLog("warn", "Sin impresora para categoria: " + categoria);
                continue;
            }

            const tipoConexion = impresoraInfo.tipo;
            const conexion = impresoraInfo.conexion;

            try {
                if (tipoConexion === "usb") {
                    await imprimirPorUSB(pedido, tipo, categoria, itemsCat, conexion);
                } else {
                    await imprimirPorRed(pedido, tipo, categoria, itemsCat, conexion);
                }
                sendLog(
                    "ok",
                    categoria + " -> " + tipoConexion.toUpperCase() + " (" + conexion + ")"
                );
            } catch (err) {
                exitoGeneral = false;
                sendLog("error", "Error en " + categoria + " (" + conexion + "): " + err.message);
            }
        }

        if (exitoGeneral) {
            try {
                if (tipo === "MESA") {
                    await axios.put(API_URL + "/pedidos-linea/marcar-impreso/" + pedido.id_mesa);
                } else {
                    await axios.put(API_URL + "/deliveries/marcar-impreso/" + pedido.id_delivery);
                }
            } catch (e) {
                sendLog("warn", "No se pudo marcar como impreso: " + e.message);
            }
        }
    }
}

function imprimirPorRed(pedido, tipo, categoria, items, ip) {
    return new Promise(function (resolve, reject) {
        const device = new escpos.Network(ip, PUERTO_IMPRESORA);
        const printer = new escpos.Printer(device);

        device.open(function (error) {
            if (error) return reject(new Error("Impresora de red desconectada: " + ip));
            try {
                construirTicketRed(printer, pedido, tipo, categoria, items);
                printer.feed(3).cut().close();
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    });
}

function imprimirPorUSB(pedido, tipo, categoria, items, conexion) {
    return new Promise(function (resolve, reject) {
        const esRaw = conexion.indexOf("/dev/usb/lp") !== -1 || conexion.indexOf("/dev/lp") !== -1;

        if (esRaw) {
            imprimirRawLinux(pedido, tipo, categoria, items, conexion).then(resolve).catch(reject);
        } else {
            imprimirPorSerial(pedido, tipo, categoria, items, conexion).then(resolve).catch(reject);
        }
    });
}

function imprimirRawLinux(pedido, tipo, categoria, items, devicePath) {
    return new Promise(function (resolve, reject) {
        const bytes = generarBytesESCPOS(pedido, tipo, categoria, items);
        const stream = fs.createWriteStream(devicePath, { flags: "w" });

        stream.on("error", function (err) {
            reject(new Error("Error raw USB: " + err.message));
        });

        stream.write(bytes, function (err) {
            if (err) return reject(new Error("Error escribiendo ticket: " + err.message));
            stream.end(function () {
                resolve();
            });
        });
    });
}

function imprimirPorSerial(pedido, tipo, categoria, items, portPath) {
    return new Promise(function (resolve, reject) {
        const port = new SerialPort({
            path: portPath,
            baudRate: 9600,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            autoOpen: false
        });

        port.open(function (err) {
            if (err) return reject(new Error("No se pudo abrir " + portPath + ": " + err.message));

            const bytes = generarBytesESCPOS(pedido, tipo, categoria, items);

            port.write(bytes, function (writeErr) {
                if (writeErr) {
                    port.close();
                    return reject(new Error("Error escribiendo al puerto: " + writeErr.message));
                }
                port.drain(function (drainErr) {
                    port.close();
                    if (drainErr) return reject(drainErr);
                    resolve();
                });
            });
        });
    });
}

function txt(texto) {
    return Buffer.from(texto + "\n", "latin1");
}

function generarBytesESCPOS(pedido, tipo, categoria, items) {
    const ESC = 0x1b;
    const GS = 0x1d;

    const INIT = Buffer.from([ESC, 0x40]);
    const ALIGN_CENTER = Buffer.from([ESC, 0x61, 0x01]);
    const ALIGN_LEFT = Buffer.from([ESC, 0x61, 0x00]);
    const ALIGN_RIGHT = Buffer.from([ESC, 0x61, 0x02]);
    const BOLD_ON = Buffer.from([ESC, 0x45, 0x01]);
    const BOLD_OFF = Buffer.from([ESC, 0x45, 0x00]);
    const DOUBLE_HEIGHT = Buffer.from([ESC, 0x21, 0x10]);
    const NORMAL_SIZE = Buffer.from([ESC, 0x21, 0x00]);
    const LINE_FEED = Buffer.from([0x0a]);
    const CUT_PARTIAL = Buffer.from([GS, 0x56, 0x01]);

    const sep = Buffer.from("--------------------------------\n", "latin1");

    const partes = [];

    partes.push(INIT);
    partes.push(ALIGN_CENTER);
    partes.push(BOLD_ON);
    partes.push(DOUBLE_HEIGHT);
    partes.push(txt("AREA: " + categoria.toUpperCase()));
    partes.push(NORMAL_SIZE);
    partes.push(BOLD_OFF);
    partes.push(ALIGN_LEFT);
    partes.push(sep);

    if (tipo === "MESA") {
        partes.push(BOLD_ON);
        partes.push(txt("MESA: " + pedido.numero_mesa));
        partes.push(BOLD_OFF);
    } else {
        partes.push(BOLD_ON);
        partes.push(txt("DELIVERY #" + pedido.id_delivery));
        partes.push(BOLD_OFF);
        partes.push(txt("DIR: " + (pedido.direccion || "")));
        if (pedido.referencia) partes.push(txt("REF: " + pedido.referencia));
        if (pedido.telefono) partes.push(txt("TEL: " + pedido.telefono));
    }

    partes.push(txt("HORA: " + new Date().toLocaleTimeString()));
    partes.push(sep);
    partes.push(LINE_FEED);

    let subtotal = 0;

    items.forEach(function (p) {
        partes.push(BOLD_ON);
        partes.push(txt(p.cantidad + "x " + p.nombre));
        partes.push(BOLD_OFF);

        if (p.variaciones_seleccionadas && p.variaciones_seleccionadas.length > 0) {
            const agrupadas = p.variaciones_seleccionadas.reduce(function (acc, v) {
                if (!acc[v.grupo]) acc[v.grupo] = [];
                acc[v.grupo].push(v.opcion);
                return acc;
            }, {});
            for (const grupo of Object.keys(agrupadas)) {
                partes.push(txt("   - " + grupo + ": " + agrupadas[grupo].join(", ")));
            }
        }

        if (p.variaciones_texto) {
            partes.push(txt("   * NOTA: " + p.variaciones_texto));
        }

        subtotal += parseFloat(p.precio) * p.cantidad;
    });

    partes.push(LINE_FEED);
    partes.push(sep);
    partes.push(ALIGN_RIGHT);
    partes.push(BOLD_ON);
    partes.push(txt("Parcial: S/ " + subtotal.toFixed(2)));
    partes.push(BOLD_OFF);
    partes.push(Buffer.from([0x0a, 0x0a, 0x0a]));
    partes.push(CUT_PARTIAL);

    return Buffer.concat(partes);
}

function construirTicketRed(printer, pedido, tipo, categoria, items) {
    printer
        .align("ct")
        .size(1, 1)
        .text("AREA: " + categoria.toUpperCase())
        .size(0, 0)
        .text("--------------------------------")
        .align("lt");

    if (tipo === "MESA") {
        printer.text("MESA: " + pedido.numero_mesa);
    } else {
        printer.text("DELIVERY #" + pedido.id_delivery);
        printer.text("DIR: " + pedido.direccion);
        if (pedido.referencia) printer.text("REF: " + pedido.referencia);
        if (pedido.telefono) printer.text("TEL: " + pedido.telefono);
    }

    printer
        .text("HORA: " + new Date().toLocaleTimeString())
        .text("--------------------------------")
        .feed(1);

    let subtotal = 0;

    items.forEach(function (p) {
        printer.text(p.cantidad + "x " + p.nombre);

        if (p.variaciones_seleccionadas && p.variaciones_seleccionadas.length > 0) {
            const agrupadas = p.variaciones_seleccionadas.reduce(function (acc, v) {
                if (!acc[v.grupo]) acc[v.grupo] = [];
                acc[v.grupo].push(v.opcion);
                return acc;
            }, {});
            for (const grupo of Object.keys(agrupadas)) {
                printer.text("   - " + grupo + ": " + agrupadas[grupo].join(", "));
            }
        }

        if (p.variaciones_texto) printer.text("   * NOTA: " + p.variaciones_texto);
        subtotal += parseFloat(p.precio) * p.cantidad;
    });

    printer
        .feed(1)
        .text("--------------------------------")
        .align("rt")
        .text("Parcial: S/ " + subtotal.toFixed(2));
}
