const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");
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
                sendLog("warn", "Sin impresora para categoria: " + categoria);
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

function buildRawBytes(pedido, tipo, categoria, items) {
    const ESC_INIT = Buffer.from([0x1b, 0x40]);
    const ESC_FEED = Buffer.from([0x1b, 0x64, 0x04]);
    const ESC_CUT = Buffer.from([0x1d, 0x56, 0x42, 0x00]);

    const sep = "--------------------------------\n";
    let texto = "";

    texto += "AREA: " + categoria.toUpperCase() + "\n";
    texto += sep;

    if (tipo === "MESA") {
        texto += "MESA: " + pedido.numero_mesa + "\n";
    } else {
        texto += "DELIVERY #" + pedido.id_delivery + "\n";
        texto += "DIR: " + pedido.direccion + "\n";
        if (pedido.referencia) texto += "REF: " + pedido.referencia + "\n";
        if (pedido.telefono) texto += "TEL: " + pedido.telefono + "\n";
    }

    texto += "FECHA: " + new Date().toLocaleTimeString() + "\n";
    texto += sep + "\n";

    let subtotal = 0;
    items.forEach(p => {
        texto += p.cantidad + "x " + p.nombre + "\n";
        if (p.variaciones_seleccionadas && p.variaciones_seleccionadas.length > 0) {
            const agrupadas = p.variaciones_seleccionadas.reduce((acc, v) => {
                if (!acc[v.grupo]) acc[v.grupo] = [];
                acc[v.grupo].push(v.opcion);
                return acc;
            }, {});
            for (const [grupo, opciones] of Object.entries(agrupadas)) {
                texto += "   - " + grupo + ": " + opciones.join(", ") + "\n";
            }
        }
        if (p.variaciones_texto) texto += "   * NOTA: " + p.variaciones_texto + "\n";
        subtotal += parseFloat(p.precio) * p.cantidad;
    });

    texto += "\n" + sep;
    texto += "Parcial: S/ " + subtotal.toFixed(2) + "\n";

    const ticketBuf = Buffer.from(texto, "ascii");
    return Buffer.concat([ESC_INIT, ticketBuf, ESC_FEED, ESC_CUT]);
}

function imprimirPorRed(pedido, tipo, categoria, items, ip) {
    return new Promise((resolve, reject) => {
        const net = require("net");
        const socket = new net.Socket();
        const payload = buildRawBytes(pedido, tipo, categoria, items);

        socket.setTimeout(5000);

        socket.connect(PUERTO_IMPRESORA, ip, () => {
            socket.write(payload, () => {
                socket.destroy();
                resolve();
            });
        });

        socket.on("error", err => {
            socket.destroy();
            reject(new Error("Impresora de red desconectada: " + ip + " - " + err.message));
        });

        socket.on("timeout", () => {
            socket.destroy();
            reject(new Error("Timeout conectando a impresora: " + ip));
        });
    });
}

function imprimirPorUSB(pedido, tipo, categoria, items, nombreImpresora) {
    return new Promise((resolve, reject) => {
        const payload = buildRawBytes(pedido, tipo, categoria, items);
        const tmpFile = path.join(os.tmpdir(), "tastica_ticket_" + Date.now() + ".bin");
        fs.writeFileSync(tmpFile, payload);

        const ps =
            "" +
            "$bytes = [System.IO.File]::ReadAllBytes('" +
            tmpFile +
            "');" +
            "$hPrinter = [IntPtr]::Zero;" +
            "[RawPrint]::OpenPrinter('" +
            nombreImpresora +
            "', [ref]$hPrinter, [IntPtr]::Zero);" +
            "$d = New-Object RawPrint+DOCINFO;" +
            "$d.pDocName = 'Ticket';" +
            "$d.pOutputFile = $null;" +
            "$d.pDataType = 'RAW';" +
            "[RawPrint]::StartDocPrinter($hPrinter, 1, [ref]$d);" +
            "[RawPrint]::StartPagePrinter($hPrinter);" +
            "$w = 0;" +
            "[RawPrint]::WritePrinter($hPrinter, $bytes, $bytes.Length, [ref]$w);" +
            "[RawPrint]::EndPagePrinter($hPrinter);" +
            "[RawPrint]::EndDocPrinter($hPrinter);" +
            "[RawPrint]::ClosePrinter($hPrinter);";

        const definition =
            "" +
            "using System;" +
            "using System.Runtime.InteropServices;" +
            "public class RawPrint {" +
            '[DllImport("winspool.drv", CharSet=CharSet.Auto, SetLastError=true)]' +
            "public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);" +
            '[DllImport("winspool.drv", SetLastError=true)]' +
            "public static extern bool ClosePrinter(IntPtr h);" +
            '[DllImport("winspool.drv", CharSet=CharSet.Auto, SetLastError=true)]' +
            "public static extern int StartDocPrinter(IntPtr h, int l, ref DOCINFO d);" +
            '[DllImport("winspool.drv", SetLastError=true)]' +
            "public static extern bool EndDocPrinter(IntPtr h);" +
            '[DllImport("winspool.drv", SetLastError=true)]' +
            "public static extern bool StartPagePrinter(IntPtr h);" +
            '[DllImport("winspool.drv", SetLastError=true)]' +
            "public static extern bool EndPagePrinter(IntPtr h);" +
            '[DllImport("winspool.drv", SetLastError=true)]' +
            "public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);" +
            "[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]" +
            "public struct DOCINFO {" +
            "[MarshalAs(UnmanagedType.LPTStr)] public string pDocName;" +
            "[MarshalAs(UnmanagedType.LPTStr)] public string pOutputFile;" +
            "[MarshalAs(UnmanagedType.LPTStr)] public string pDataType;" +
            "}}";

        const fullScript = "Add-Type -TypeDefinition '" + definition + "';" + ps;

        exec('powershell -NoProfile -Command "' + fullScript + '"', err => {
            setTimeout(() => fs.unlink(tmpFile, () => {}), 3000);
            if (err) return reject(new Error("Error USB " + nombreImpresora + ": " + err.message));
            resolve();
        });
    });
}
