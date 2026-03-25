const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");
const escpos = require("escpos");
escpos.Network = require("escpos-network");
const { exec } = require("child_process");

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

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
        iniciarAgente();
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
        if (agenteLoop) clearInterval(agenteLoop);
        app.quit();
    });
}

app.whenReady().then(() => {
    if (process.platform === "linux") {
        app.commandLine.appendSwitch("no-sandbox");
    }
    createWindow();
});

app.on("window-all-closed", () => {
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

ipcMain.handle("guardar-sede", async (_, id_sede) => {
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

ipcMain.handle("leer-config", async () => {
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
            sendLog("error", "Error leyendo configuración: " + e.message);
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

    agenteLoop = setInterval(async () => {
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
                .catch(() => ({ data: [] }));
            const resDeliveries = await axios
                .get(API_URL + "/deliveries/impresion-pendiente/" + id_sede)
                .catch(() => ({ data: [] }));

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

        items.forEach(p => {
            const cat = p.categoria || "Otros";
            if (!grupos[cat]) grupos[cat] = [];
            grupos[cat].push(p);
        });

        let exitoGeneral = true;

        for (const [categoria, itemsCat] of Object.entries(grupos)) {
            const impresoraInfo = configImpresoras[categoria];

            if (!impresoraInfo) {
                sendLog("warn", "Sin impresora para categoría: " + categoria);
                continue;
            }

            const { tipo: tipoConexion, conexion } = impresoraInfo;

            try {
                if (tipoConexion === "usb") {
                    await imprimirPorUSB(pedido, tipo, categoria, itemsCat, conexion);
                } else {
                    await imprimirPorRed(pedido, tipo, categoria, itemsCat, conexion);
                }
                sendLog(
                    "ok",
                    categoria + " → " + tipoConexion.toUpperCase() + " (" + conexion + ")"
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
    return new Promise((resolve, reject) => {
        const device = new escpos.Network(ip, PUERTO_IMPRESORA);
        const printer = new escpos.Printer(device);

        device.open(error => {
            if (error) return reject(new Error("Impresora de red desconectada: " + ip));
            try {
                construirTicket(printer, pedido, tipo, categoria, items);
                printer.feed(3).cut().close();
                resolve();
            } catch (err) {
                reject(err);
            }
        });
    });
}

function imprimirPorUSB(pedido, tipo, categoria, items, nombreImpresora) {
    return new Promise((resolve, reject) => {
        const lineas = generarLineasTicket(pedido, tipo, categoria, items);
        const contenido = lineas.join("\r\n");
        const tmpFile = path.join(os.tmpdir(), "tastica_ticket_" + Date.now() + ".txt");
        fs.writeFileSync(tmpFile, contenido, "utf-8");

        let comando;
        if (os.platform() === "win32") {
            const tmpEscapado = tmpFile.replace(/\\/g, "\\\\");
            comando =
                `powershell -Command "` +
                `$raw = [System.IO.File]::ReadAllBytes('${tmpEscapado}'); ` +
                `$ticket = [System.Text.Encoding]::Default.GetString($raw); ` +
                `$pd = New-Object System.Drawing.Printing.PrintDocument; ` +
                `$pd.PrinterSettings.PrinterName = '${nombreImpresora}'; ` +
                `$pd.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('Custom', 300, 1100); ` +
                `$pd.Add_PrintPage({ param($s, $e) $e.Graphics.DrawString($ticket, (New-Object System.Drawing.Font('Courier New', 9)), [System.Drawing.Brushes]::Black, 0, 0) }); ` +
                `$pd.Print()"`;
        } else {
            comando = `lp -d "${nombreImpresora}" "${tmpFile}"`;
        }

        sendLog("info", "Ejecutando impresión en: " + nombreImpresora);

        exec(comando, (err, stdout, stderr) => {
            if (stdout) sendLog("info", "stdout: " + stdout);
            if (stderr) sendLog("warn", "stderr: " + stderr);
            fs.unlink(tmpFile, () => {});
            if (err) return reject(new Error("Error USB " + nombreImpresora + ": " + err.message));
            resolve();
        });
    });
}

function generarLineasTicket(pedido, tipo, categoria, items) {
    const sep = "--------------------------------";
    const lineas = [];
    lineas.push("AREA: " + categoria.toUpperCase());
    lineas.push(sep);
    if (tipo === "MESA") {
        lineas.push("MESA: " + pedido.numero_mesa);
    } else {
        lineas.push("DELIVERY #" + pedido.id_delivery);
        lineas.push("DIR: " + pedido.direccion);
        if (pedido.referencia) lineas.push("REF: " + pedido.referencia);
        if (pedido.telefono) lineas.push("TEL: " + pedido.telefono);
    }
    lineas.push("FECHA: " + new Date().toLocaleTimeString());
    lineas.push(sep);
    lineas.push("");
    let subtotal = 0;
    items.forEach(p => {
        lineas.push(p.cantidad + "x " + p.nombre);
        if (p.variaciones_seleccionadas && p.variaciones_seleccionadas.length > 0) {
            const agrupadas = p.variaciones_seleccionadas.reduce((acc, v) => {
                if (!acc[v.grupo]) acc[v.grupo] = [];
                acc[v.grupo].push(v.opcion);
                return acc;
            }, {});
            for (const [grupo, opciones] of Object.entries(agrupadas)) {
                lineas.push("   - " + grupo + ": " + opciones.join(", "));
            }
        }
        if (p.variaciones_texto) lineas.push("   * NOTA: " + p.variaciones_texto);
        subtotal += parseFloat(p.precio) * p.cantidad;
    });
    lineas.push("");
    lineas.push(sep);
    lineas.push("Parcial: S/ " + subtotal.toFixed(2));
    lineas.push("\n\n\n");
    return lineas;
}

function construirTicket(printer, pedido, tipo, categoria, items) {
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
        .text("FECHA: " + new Date().toLocaleTimeString())
        .text("--------------------------------")
        .feed(1);
    let subtotal = 0;
    items.forEach(p => {
        printer.text(p.cantidad + "x " + p.nombre);
        if (p.variaciones_seleccionadas && p.variaciones_seleccionadas.length > 0) {
            const agrupadas = p.variaciones_seleccionadas.reduce((acc, v) => {
                if (!acc[v.grupo]) acc[v.grupo] = [];
                acc[v.grupo].push(v.opcion);
                return acc;
            }, {});
            for (const [grupo, opciones] of Object.entries(agrupadas)) {
                printer.text("   - " + grupo + ": " + opciones.join(", "));
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
