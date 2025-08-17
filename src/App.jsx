import React, { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode"; // Generación de QR en cliente
import { Html5Qrcode } from "html5-qrcode"; // Escaneo con cámara
import { supabase } from "./supabase";

// Demo POS + Inventario + Cocina + Admin + Bitácora
// Persistencia localStorage. Moneda MXN. Pensado para uso offline.

// Utilidades
const mxn = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString();

// Claves de almacenamiento
const LS_KEYS = {
  inventory: "demo_pos_inventory",
  sales: "demo_pos_sales",
  moves: "demo_pos_cash_moves", // ingresos/egresos manuales y compras
  membership: "demo_pos_membership_prices",
  startCash: "demo_pos_start_cash",
  dayOpenedAt: "demo_pos_day_opened_at",
  auth: "demo_pos_auth",
};

// Productos semilla
const seedInventory = () => ([
  { id: uid(), name: "Agua 600 ml", price: 12, stock: 30 },
  { id: uid(), name: "Leche Santa Clara 1 L", price: 32, stock: 18 },
  { id: uid(), name: "Sabritas 45 g", price: 17, stock: 25 },
  { id: uid(), name: "Huevo Finder docena", price: 48, stock: 10 },
]);

// Usuarios de prueba (sustituir por BD más adelante)
const DEMO_USERS = [
  { email: "admin@ludo.local", password: "admin123", role: "admin", name: "Admin" },
  { email: "worker@ludo.local", password: "worker123", role: "trabajador", name: "Trabajador" },
];

// Helpers puros para totales (testeables)
function calcTotals(sales, moves, startCash) {
  const totalVentas = sales.reduce((s, v) => s + v.total, 0);
  const totalVentasCaja = sales.reduce((s, v) => s + (v.method === 'transferencia' ? 0 : v.total), 0);
  const totalVentasTransfer = sales.reduce((s, v) => s + (v.method === 'transferencia' ? v.total : 0), 0);
  const totalIngresosManual = moves.filter(m => m.type === 'ingreso').reduce((s, m) => s + m.amount, 0);
  const totalEgresos = moves.filter(m => m.type === 'egreso' || m.type === 'compra').reduce((s, m) => s + m.amount, 0);
  const cashInRegister = startCash + totalVentasCaja + totalIngresosManual - totalEgresos;
  return { totalVentas, totalVentasCaja, totalVentasTransfer, totalIngresosManual, totalEgresos, cashInRegister };
}
function cartTotal(items) { return items.reduce((s, it) => s + it.price * it.qty, 0); }
function computeChange(paid, total) { return Math.max(0, Number(paid || 0) - total); }

// QR helpers (v1: solo id)
function encodeProductQRData(product) {
  return JSON.stringify({ v: 1, id: product.id });
}
function decodeProductQRData(str) {
  try {
    const obj = JSON.parse(str);
    if (obj && obj.v === 1 && obj.id) return { id: obj.id }; // v1
    if (obj && (obj.id || obj.name)) return obj; // compat: legado {id,name,price}
  } catch {}
  return null;
}
function applyScanToCart(cart, inventory, payload, qty = 1) {
  const findById = payload.id && inventory.find(p => p.id === payload.id);
  const prod = findById || inventory.find(p => p.name.toLowerCase() === String(payload.name||'').toLowerCase());
  if (!prod) return { cart, error: 'Producto no encontrado' };
  if (qty > prod.stock) return { cart, error: 'Stock insuficiente' };
  const exists = cart.find(i => i.id === prod.id);
  let next;
  if (exists) next = cart.map(i => i.id === prod.id ? { ...i, qty: i.qty + qty } : i);
  else next = [...cart, { id: prod.id, name: prod.name, price: prod.price, qty }];
  return { cart: next };
}

// Helper puro para ajustes de Admin sobre una venta
function adminAdjustSaleItemPure(sale, itemId, newQty) {
  const idx = sale.items.findIndex(i => i.id === itemId);
  if (idx === -1) return { sale, restored: 0 };
  const item = sale.items[idx];
  const qty = Math.max(0, Math.min(item.qty, newQty));
  const restored = item.qty - qty; // unidades que regresan a inventario
  const items = [...sale.items];
  if (qty === 0) items.splice(idx, 1); else items[idx] = { ...item, qty, subtotal: qty * item.price };
  const total = items.reduce((s, it) => s + it.subtotal, 0);
  const updated = { ...sale, items, total, change: sale.paid - total };
  return { sale: updated, restored };
}

export default function App() {
  // Estado base
  const [inventory, setInventory] = useState(() => {
    const saved = localStorage.getItem(LS_KEYS.inventory);
    return saved ? JSON.parse(saved) : seedInventory();
  });
  const [sales, setSales] = useState(() => {
    const saved = localStorage.getItem(LS_KEYS.sales);
    return saved ? JSON.parse(saved) : [];
  });
  const [moves, setMoves] = useState(() => {
    const saved = localStorage.getItem(LS_KEYS.moves);
    return saved ? JSON.parse(saved) : [];
  }); // {id, type:'ingreso'|'egreso'|'compra', concept, amount, ts}
  const [startCash, setStartCash] = useState(() => {
    const saved = localStorage.getItem(LS_KEYS.startCash);
    return saved ? Number(saved) : 0;
  });
  const [dayOpenedAt, setDayOpenedAt] = useState(() => {
    const saved = localStorage.getItem(LS_KEYS.dayOpenedAt);
    return saved || todayISO();
  });
  const [membership, setMembership] = useState(() => {
    const saved = localStorage.getItem(LS_KEYS.membership);
    return saved ? JSON.parse(saved) : {
      ludoteca: { v12: 80, v36: 130, p1: 450, p2: 750 },
      reforzamiento: { visita: 99, m12: 899, m15: 1050, m20: 1299 },
      terapia: { individual: 400, ocho: 2800 },
    };
  });
  const reloadMembership = async () => {
    const { data, error } = await supabase
      .from('membership_prices')
      .select('service,"key",price');
    if (error) return;
    const m = { ludoteca: {}, reforzamiento: {}, terapia: {} };
    for (const r of data) m[r.service][r.key] = Number(r.price);
    setMembership(m);
  };

  const applyMembershipChange = (service, key, value) => {
    const num = Number(value || 0);
    setMembership(m => ({ ...m, [service]: { ...m[service], [key]: num } }));
    supabase.from('membership_prices').upsert({
      service, key, price: num, updated_by: auth?.id ?? null
    });
  };

  const [tab, setTab] = useState("cocina"); // 'cocina' en lugar de 'venta'
  const [auth, setAuth] = useState(() => {
    const saved = localStorage.getItem(LS_KEYS.auth);
    return saved ? JSON.parse(saved) : null;
  });
  const role = auth?.role ?? 'trabajador';

  // --- Carga desde Supabase + Realtime ---
  const reloadInventory = async () => {
    const { data, error } = await supabase.from('inventory').select('*').order('name');
    if (!error && data) setInventory(data);
  };
  const reloadSales = async () => {
    const { data, error } = await supabase
      .from('sales')
      .select('id, ts, method, total, paid, change, note, sale_items(id, product_id, name, price, qty, subtotal)')
      .order('ts', { ascending: false });
    if (!error && data) {
      const flat = data.map(s => ({
        id: s.id, ts: s.ts, method: s.method, total: s.total, paid: s.paid, change: s.change, note: s.note || '',
        items: (s.sale_items||[]).map(it => ({ id: it.product_id, name: it.name, price: it.price, qty: it.qty, subtotal: it.subtotal }))
      }));
      setSales(flat);
    }
  };
  const reloadMoves = async () => {
    const { data, error } = await supabase.from('cash_moves').select('*').order('ts', { ascending: false });
    if (!error && data) setMoves(data);
  };
  const reloadRegister = async () => {
    const { data } = await supabase.from('register_state').select('*').eq('id','default').maybeSingle();
    if (data) { setStartCash(Number(data.start_cash)||0); setDayOpenedAt(data.opened_at); }
    else {
      await supabase.from('register_state').insert({ id: 'default', start_cash: 0 });
      const { data: d2 } = await supabase.from('register_state').select('*').eq('id','default').single();
      if (d2) { setStartCash(Number(d2.start_cash)||0); setDayOpenedAt(d2.opened_at); }
    }
  };

  useEffect(() => {
    if (auth) {
      reloadInventory();
      reloadSales();
      reloadMoves();
      reloadRegister();
      reloadMembership();
    }
  }, [auth]);

  useEffect(() => {
    const ch = supabase
      .channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, reloadInventory)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sales' }, reloadSales)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sale_items' }, reloadSales)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cash_moves' }, reloadMoves)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'register_state' }, reloadRegister)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'membership_prices' }, reloadMembership)
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch {} };
  }, []);

  // Carrito de venta actual
  const [cart, setCart] = useState([]); // {id, name, price, qty}
  const [search, setSearch] = useState("");
  const [paid, setPaid] = useState("");
  const [payMethod, setPayMethod] = useState('caja');
  const [msg, setMsg] = useState("");

  // Scanner state (Cocina)
  const [scanActive, setScanActive] = useState(false);
  const qrRef = useRef(null);
  const qrInstance = useRef(null);
  const lastScan = useRef({ text: '', at: 0 }); // antirrebote
  const scanCooldown = useRef(new Map());

  // QR modal state
  const [qrProduct, setQrProduct] = useState(null); // product en modal
  const [qrDataUrl, setQrDataUrl] = useState("");

  // Si se cambia a trabajador y estaba en Admin, regresa a Cocina
  useEffect(() => { if (role !== 'admin' && tab === 'admin') setTab('cocina'); }, [role, tab]);

  // Persistencia
  useEffect(() => localStorage.setItem(LS_KEYS.inventory, JSON.stringify(inventory)), [inventory]);
  useEffect(() => localStorage.setItem(LS_KEYS.sales, JSON.stringify(sales)), [sales]);
  useEffect(() => localStorage.setItem(LS_KEYS.moves, JSON.stringify(moves)), [moves]);
  useEffect(() => localStorage.setItem(LS_KEYS.startCash, String(startCash)), [startCash]);
  useEffect(() => localStorage.setItem(LS_KEYS.dayOpenedAt, dayOpenedAt), [dayOpenedAt]);
  useEffect(() => localStorage.setItem(LS_KEYS.membership, JSON.stringify(membership)), [membership]);
  useEffect(() => {
    if (auth) localStorage.setItem(LS_KEYS.auth, JSON.stringify(auth));
    else localStorage.removeItem(LS_KEYS.auth);
  }, [auth]);
  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const session = data.session;
      if (!session) return;
      const { data: prof } = await supabase
        .from('profiles')
        .select('name, role')
        .eq('id', session.user.id)
        .single();
      if (prof) setAuth({ email: session.user.email, name: prof.name, role: prof.role, id: session.user.id });
    });
  }, []);

  // Totales memoizados usando funciones puras
  const { totalVentas, totalVentasCaja, totalVentasTransfer, totalIngresosManual, totalEgresos, cashInRegister } = useMemo(() => (
    calcTotals(sales, moves, startCash)
  ), [sales, moves, startCash]);

  const catalogFiltered = useMemo(() => inventory.filter(p => p.name.toLowerCase().includes(search.toLowerCase())), [inventory, search]);
  const totalCarrito = useMemo(() => cartTotal(cart), [cart]);

  // Helpers de UI
  const toast = (t) => { setMsg(t); setTimeout(() => setMsg(""), 2200); };

  // Operaciones de Venta (Trabajador)
  const addToCart = (product, qty = 1) => {
    if (qty <= 0) return;
    if (qty > product.stock) { toast("Stock insuficiente"); return; }
    setCart(prev => {
      const exists = prev.find(i => i.id === product.id);
      if (exists) return prev.map(i => i.id === product.id ? { ...i, qty: Math.min(i.qty + qty, product.stock) } : i);
      return [...prev, { id: product.id, name: product.name, price: product.price, qty }];
    });
  };
  const updateQty = (id, qty) => {setCart(prev => prev.map(i => i.id === id ? { ...i, qty } : i)); };  
  const clampQty = (id) => {setCart(prev => prev.map(i => i.id === id ? { ...i, qty: Math.max(1, Number(i.qty) || 1) } : i));};
  const removeFromCart = (id) => setCart(prev => prev.filter(i => i.id !== id));

  const cobrar = async () => {
    const paidNum = Number(paid);
    const currentCart = cart.filter(i => Number(i.qty) > 0);
    if (!currentCart.length) { toast('Carrito vacío'); return; }
    const totalVenta = cartTotal(currentCart);
    if (isNaN(paidNum) || paidNum < totalVenta) { toast('Pago insuficiente'); return; }

    const items = currentCart.map(i => ({ id: i.id, qty: i.qty }));
    const { data, error } = await supabase.rpc('process_sale', {
      _method: payMethod,
      _paid: paidNum,
      _note: '',
      _items: items
    });
    if (error) { toast(error.message || 'Error al cobrar'); return; }
    setCart([]); setPaid(''); setPayMethod('caja'); toast('Venta registrada');
    await reloadInventory(); await reloadSales();
  };

  // Venta de servicios (no inventario)
  const registerServiceSale = async ({ method, items, total, paid, note }) => {
    const paidNum = Number(paid);
    const change = computeChange(paidNum, total);
    const { data: sale, error } = await supabase
      .from('sales')
      .insert({ method, total, paid: paidNum, change, note })
      .select()
      .single();
    if (error) { toast('Error al registrar'); return; }
    if (items?.length) {
      const rows = items.map(i => ({ sale_id: sale.id, product_id: null, name: i.name, price: i.price, qty: i.qty, subtotal: i.price * i.qty }));
      await supabase.from('sale_items').insert(rows);
    }
    setSales(prev => [{ id: sale.id, ts: sale.ts, method: sale.method, total: sale.total, paid: sale.paid, change: sale.change, note: sale.note || '', items: items.map(i => ({ id: null, name: i.name, price: i.price, qty: i.qty, subtotal: i.price * i.qty })) }, ...prev]);
    toast('Venta registrada');
  };

  // Inventario
  const createProduct = async (name, price, stock) => {
    if (!name || price < 0 || stock < 0) return;
    const { data, error } = await supabase.from('inventory').insert({ name, price, stock }).select().single();
    if (error) { toast('Error al crear'); return; }
    setInventory(prev => [data, ...prev]);
    toast('Producto agregado');
  };
  const addStock = async (id, qty, cost = 0) => {
    if (qty <= 0) return;
    const prod = inventory.find(p => p.id === id);
    const newStock = (prod?.stock || 0) + qty;
    const { error } = await supabase.from('inventory').update({ stock: newStock }).eq('id', id);
    if (error) { toast('Error al actualizar stock'); return; }
    setInventory(prev => prev.map(p => p.id === id ? { ...p, stock: newStock } : p));
    if (cost > 0) await supabase.from('cash_moves').insert({ type: 'compra', concept: 'Compra de inventario', amount: cost });
    toast('Stock actualizado');
  };
  const updatePrice = async (id, price) => {
    if (price < 0) return;
    const { error } = await supabase.from('inventory').update({ price }).eq('id', id);
    if (error) { toast('Error al actualizar precio'); return; }
    setInventory(prev => prev.map(p => p.id === id ? { ...p, price } : p));
  };
  const removeProduct = async (id) => {
    const { error } = await supabase.from('inventory').delete().eq('id', id);
    if (error) { toast('Error al eliminar'); return; }
    setInventory(prev => prev.filter(p => p.id !== id));
  };

  // Movimientos de caja manuales
  const addMove = async (type, concept, amount) => {
    if (!concept || amount <= 0) return;
    const { error, data } = await supabase.from('cash_moves').insert({ type, concept, amount }).select().single();
    if (error) { toast('Error al registrar'); return; }
    setMoves(prev => [data, ...prev]);
    toast((type === 'ingreso' ? 'Ingreso' : 'Egreso') + ' registrado');
  };

  // ADMIN: ajustes sobre ventas
  const adminChangeItemQty = async (saleId, itemId, newQty) => {
    const { error } = await supabase.rpc('admin_adjust_sale_item', { _sale_id: saleId, _product_id: itemId, _new_qty: newQty });
    if (error) { toast('Error al ajustar'); return; }
    await reloadInventory(); await reloadSales();
    toast('Venta ajustada');
  };
  const adminDeleteSale = async (saleId) => {
    const { error } = await supabase.rpc('admin_delete_sale', { _sale_id: saleId });
    if (error) { toast('Error al eliminar'); return; }
    await reloadInventory(); await reloadSales();
    toast('Venta eliminada y stock devuelto');
  };

  // Cierre de día
  const resumenPorProducto = useMemo(() => {
    const map = new Map();
    for (const s of sales) for (const it of s.items) {
      const k = it.id;
      const prev = map.get(k) || { name: it.name, unidades: 0, ingresos: 0 };
      prev.unidades += it.qty; prev.ingresos += it.subtotal; map.set(k, prev);
    }
    return Array.from(map.values()).sort((a, b) => b.ingresos - a.ingresos);
  }, [sales]);

  // CSV helpers
  const descargarCSV = (rows, namePrefix = 'reporte') => {
    const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${namePrefix}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };

  const descargarCSVCierre = () => {
    const rows = [
      ['Producto', 'Unidades vendidas', 'Ingresos'],
      ...resumenPorProducto.map(r => [r.name, String(r.unidades), r.ingresos.toFixed(2)]),
      [], ['Totales', '', ''],
      ['Ventas', '', totalVentas.toFixed(2)],
      ['Ventas en caja', '', totalVentasCaja.toFixed(2)],
      ['Ventas por transferencia', '', totalVentasTransfer.toFixed(2)],
      ['Ingresos manuales', '', totalIngresosManual.toFixed(2)],
      ['Egresos', '', totalEgresos.toFixed(2)],
      ['Caja inicial', '', startCash.toFixed(2)],
      ['Caja final', '', cashInRegister.toFixed(2)],
    ];
    descargarCSV(rows, 'cierre');
  };

  const cerrarDia = async () => {
    if (!confirm('¿Cerrar el día y reiniciar ventas/egresos?')) return;
    const opened = new Date(dayOpenedAt).toISOString();
    await supabase.from('register_state').update({ start_cash: cashInRegister, opened_at: todayISO() }).eq('id','default');
    await supabase.from('sales').delete().gte('ts', opened);
    await supabase.from('cash_moves').delete().gte('ts', opened);
    await reloadSales(); await reloadMoves(); await reloadRegister();
    toast('Día cerrado');
  };

  const resetAll = () => {
    if (!confirm("Restablecer TODO a valores de demo?")) return;
    setInventory(seedInventory()); setSales([]); setMoves([]); setStartCash(0); setDayOpenedAt(todayISO());
  };

  // Consolidación mensual: exporta CSV y elimina ventas/movimientos del mes
  const consolidateMonth = async (startDate) => {
    const start = new Date(startDate);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const inRange = (ts) => { const t = new Date(ts); return t >= start && t < end; };
    const monthSales = sales.filter(s => inRange(s.ts));
    const monthMoves = moves.filter(m => inRange(m.ts));

    const ventasCaja = monthSales.filter(s => s.method !== 'transferencia').reduce((a, s) => a + s.total, 0);
    const ventasTransfer = monthSales.filter(s => s.method === 'transferencia').reduce((a, s) => a + s.total, 0);
    const ingresosManual = monthMoves.filter(m => m.type === 'ingreso').reduce((a, m) => a + m.amount, 0);
    const egresos = monthMoves.filter(m => m.type === 'egreso' || m.type === 'compra').reduce((a, m) => a + m.amount, 0);

    const totalIngresosCaja = ventasCaja + ingresosManual;
    const totalEgresosCaja = egresos;
    const balanceCaja = totalIngresosCaja - totalEgresosCaja;

    const ym = `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}`;
    const rows = [
      ['Resumen mensual', ym],
      [],
      ['Ventas en caja', ventasCaja.toFixed(2)],
      ['Ventas por transferencia', ventasTransfer.toFixed(2)],
      ['Ingresos manuales', ingresosManual.toFixed(2)],
      ['Egresos/Compras', egresos.toFixed(2)],
      [],
      ['Total ingresos de caja', totalIngresosCaja.toFixed(2)],
      ['Total egresos de caja', totalEgresosCaja.toFixed(2)],
      ['Balance de caja (ingresos - egresos)', balanceCaja.toFixed(2)],
    ];
    descargarCSV(rows, `bitacora_mes_${ym}`);

    await supabase.from('sales').delete().gte('ts', start.toISOString()).lt('ts', end.toISOString());
    await supabase.from('cash_moves').delete().gte('ts', start.toISOString()).lt('ts', end.toISOString());
    await reloadSales(); await reloadMoves();
    toast('Mes consolidado y depurado');
  };

  // ------- Scanner control -------
  useEffect(() => {
    if (!scanActive) { if (qrInstance.current) { try { qrInstance.current.stop().catch(()=>{}); } catch{} qrInstance.current = null; } return; }
    const id = "qr-reader";
    if (!qrRef.current) qrRef.current = document.getElementById(id);
    if (!qrRef.current) return;
    const html5QrCode = new Html5Qrcode(id);
    qrInstance.current = html5QrCode;
    html5QrCode.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, onScanSuccess, () => {})
      .catch(() => toast('No se pudo iniciar la cámara'));
    return () => { try { html5QrCode.stop().catch(()=>{}); } catch{} };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanActive]);

  const onScanSuccess = (decodedText) => {
    const now = Date.now();
    const last = scanCooldown.current.get(decodedText) || 0;
    if (now - last < 700) return; // cooldown por QR ~0.7s
    scanCooldown.current.set(decodedText, now);
  
    const payload = decodeProductQRData(decodedText);
    if (!payload) { toast('QR inválido'); return; }
  
    setCart(prev => {
      const res = applyScanToCart(prev, inventory, payload, 1);
      if (res.error) { toast(res.error); return prev; }
      return res.cart;
    });
  };


  // ------- QR Modal -------
  useEffect(() => {
    if (!qrProduct) { setQrDataUrl(""); return; }
    const data = encodeProductQRData(qrProduct);
    QRCode.toDataURL(data, { width: 256, margin: 1 }).then(setQrDataUrl).catch(() => setQrDataUrl(""));
  }, [qrProduct]);

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {!auth ? (<Login onLogin={setAuth} />) : (<>
        <header className="sticky top-0 z-10 bg-white shadow">
  <div className="mx-auto w-full px-4 py-3 flex items-center">
    <h1 className="text-xl font-bold flex-shrink-0 mr-3">LudoBlack</h1>
    <div className="flex-1 min-w-0 overflow-x-auto whitespace-nowrap no-scrollbar">
      <div className="inline-flex items-center gap-2 text-sm">
        <span className="px-2 py-1 rounded bg-gray-100">Caja: <b>{mxn.format(cashInRegister)}</b></span>
        <span className="px-2 py-1 rounded bg-gray-100">Transf.: <b>{mxn.format(totalVentasTransfer)}</b></span>

        <button className={`px-3 py-1 rounded ${tab==='cocina'?'bg-gray-900 text-white':'bg-blue-100 hover:bg-blue-200'}`} onClick={() => setTab("cocina")}>Cocina</button>
        <button className={`px-3 py-1 rounded ${tab==='ludoteca'?'bg-gray-900 text-white':'bg-green-100 hover:bg-green-200'}`} onClick={() => setTab('ludoteca')}>Ludoteca</button>
        <button className={`px-3 py-1 rounded ${tab==='reforzamiento'?'bg-gray-900 text-white':'bg-indigo-100 hover:bg-indigo-200'}`} onClick={() => setTab('reforzamiento')}>Reforzamiento</button>
        <button className={`px-3 py-1 rounded ${tab==='terapia'?'bg-gray-900 text-white':'bg-purple-100 hover:bg-purple-200'}`} onClick={() => setTab('terapia')}>Terapia de Lenguaje</button>
        <button className={`px-3 py-1 rounded ${tab==='inventario'?'bg-gray-900 text-white':'bg-amber-100 hover:bg-amber-200'}`} onClick={() => setTab("inventario")}>Inventario</button>
        <button className={`px-3 py-1 rounded ${tab==='costos'?'bg-gray-900 text-white':'bg-cyan-100 hover:bg-cyan-200'}`} onClick={() => setTab('costos')}>Costos membresias</button>
        <button className={`px-3 py-1 rounded ${tab==='cierre'?'bg-gray-900 text-white':'bg-slate-100 hover:bg-slate-200'}`} onClick={() => setTab("cierre")}>Cierre</button>
        <button className={`px-3 py-1 rounded ${tab==='bitacora'?'bg-gray-900 text-white':'bg-rose-100 hover:bg-rose-200'}`} onClick={() => setTab("bitacora")}>Bitácora</button>
        {role === 'admin' && (
          <button className={`px-3 py-1 rounded ${tab==='admin'?'bg-gray-900 text-white':'bg-gray-100 hover:bg-gray-200'}`} onClick={() => setTab('admin')}>Admin</button>
        )}
        <button className="px-3 py-1 rounded bg-red-50 hover:bg-red-100" onClick={async () => { await supabase.auth.signOut(); setAuth(null); }}> Cerrar sesión</button>
      </div>
    </div>
  </div>
</header>

      {msg && (<div className="fixed top-20 left-0 right-0 mx-auto max-w-md bg-black text-white text-sm px-3 py-2 rounded shadow text-center">{msg}</div>)}

      <main className="mx-auto max-w-6xl px-4 py-6">

        {tab === "cocina" && (
          <section className="grid md:grid-cols-2 gap-6">
            {/* Escáner */}
            <div className="bg-white rounded-2xl shadow p-4">
              <h2 className="text-lg font-semibold mb-2">Escanear QR</h2>
              <div className="flex items-center gap-3 mb-3">
                {!scanActive ? (
                  <button className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700" onClick={() => setScanActive(true)}>Iniciar escaneo</button>
                ) : (
                  <button className="px-3 py-2 rounded bg-orange-600 text-white hover:bg-orange-700" onClick={() => setScanActive(false)}>Detener</button>
                )}
              </div>
              <div id="qr-reader" className="rounded overflow-hidden bg-black/5 min-h-[260px] flex items-center justify-center">
                {!scanActive && <div className="text-sm text-gray-500 p-6 text-center">Pulsa “Iniciar escaneo” y apunta a códigos QR de productos.</div>}
              </div>
            </div>

            {/* Carrito */}
            <div className="bg-white rounded-2xl shadow p-4">
              <h2 className="text-lg font-semibold mb-3">Cocina · Carrito</h2>
              <div className="max-h-[360px] overflow-auto">
                {cart.length ? (
                  <table className="w-full text-sm">
                    <thead className="text-left text-gray-500"><tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th><th></th></tr></thead>
                    <tbody>
                      {cart.map(item => (
                        <tr key={item.id} className="border-t">
                          <td className="py-2">{item.name}</td>
                          <td>
                            <input
                              type="number"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              step="1"
                              min={1}
                              value={item.qty}
                              onChange={e => updateQty(item.id, e.target.value === '' ? 0 : Number(e.target.value))}
                              onBlur={() => clampQty(item.id)}
                              className="w-16 px-2 py-1 border rounded"
                            />
                          </td>
                          <td>{mxn.format(item.price)}</td>
                          <td>{mxn.format(item.price * item.qty)}</td>
                          <td><button className="text-red-600 hover:underline" onClick={() => removeFromCart(item.id)}>Quitar</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (<div className="text-sm text-gray-500">Escanea o agrega productos para empezar</div>)}
              </div>

              <div className="mt-4 flex items-center justify-between text-lg">
                <div>Total</div>
                <div className="font-bold">{mxn.format(totalCarrito)}</div>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-3 items-end">
                <div>
                  <label className="text-sm text-gray-500">Método</label>
                  <select value={payMethod} onChange={e => setPayMethod(e.target.value)} className="w-full px-3 py-2 border rounded">
                    <option value="caja">Caja</option>
                    <option value="transferencia">Transferencia</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm text-gray-500">Pagó con</label>
                  <input type="number" inputMode="decimal" step="any" value={paid} onChange={e => setPaid(e.target.value)} className="w-full px-3 py-2 border rounded" />
                </div>
                <div>
                  <div className="text-sm text-gray-500">Cambio</div>
                  <div className="text-xl font-semibold">{mxn.format(computeChange(paid, totalCarrito))}</div>
                </div>
              </div>

              <div className="mt-4 flex gap-3">
                <button className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700" onClick={cobrar} disabled={!cart.length || Number(paid) < totalCarrito}>Cobrar</button>
                <button className="px-4 py-2 rounded bg-gray-100 hover:bg-gray-200" onClick={() => { setCart([]); setPaid(""); }}>Vaciar</button>
              </div>

              <div className="mt-6 text-sm text-gray-600">
                Caja actual: <b>{mxn.format(cashInRegister)}</b> · Ventas del día: <b>{mxn.format(totalVentas)}</b> · Transferencias: <b>{mxn.format(totalVentasTransfer)}</b>
              </div>

              {/* Catálogo para clic manual */}
              <div className="mt-6">
                <h3 className="font-semibold mb-2">Catálogo</h3>
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar producto" className="w-full mb-3 px-3 py-2 border rounded" />
                <div className="max-h-60 overflow-auto divide-y">
                  {catalogFiltered.map(p => (
                    <div key={p.id} className="flex items-center justify-between py-2 gap-3">
                      <div>
                        <div className="font-medium">{p.name}</div>
                        <div className="text-sm text-gray-500">{mxn.format(p.price)} · Stock {p.stock}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <input type="number" inputMode="numeric" pattern="[0-9]*" min={1} defaultValue={1} className="w-16 px-2 py-1 border rounded" id={`qty_${p.id}`} />
                        <button className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700" onClick={() => {
                          const el = document.getElementById(`qty_${p.id}`);
                          const qty = Number(el?.value || 1); addToCart(p, qty);
                        }}>Agregar</button>
                      </div>
                    </div>
                  ))}
                  {catalogFiltered.length === 0 && (<div className="text-sm text-gray-500 py-8 text-center">Sin resultados</div>)}
                </div>
              </div>
            </div>
          </section>
        )}

{tab === 'costos' && (
  <section className="grid gap-6">
    <div className="bg-white rounded-2xl shadow p-4">
      <h2 className="text-lg font-semibold mb-3">Costos membresias</h2>
      <div className="grid md:grid-cols-3 gap-6 text-sm">
        <div>
          <h3 className="font-semibold mb-2">Ludoteca</h3>
          <label className="block mb-2">Visita 1-2 HRS
            <input type="number" inputMode="decimal" step="any" min={0}
              defaultValue={membership.ludoteca.v12}
              key={membership.ludoteca.v12}
              onBlur={e => applyMembershipChange('ludoteca','v12', e.target.value)}
              className="mt-1 w-full px-3 py-2 border rounded" />
          </label>
          <label className="block mb-2">Visita 3-6 HRS
            <input type="number" inputMode="decimal" step="any" min={0}
              defaultValue={membership.ludoteca.v36}
              key={membership.ludoteca.v36}
              onBlur={e => applyMembershipChange('ludoteca','v36', e.target.value)}
              className="mt-1 w-full px-3 py-2 border rounded" />
          </label>
          <label className="block mb-2">Paquete 1
            <input type="number" inputMode="decimal" step="any" min={0}
              defaultValue={membership.ludoteca.p1}
              key={membership.ludoteca.p1}
              onBlur={e => applyMembershipChange('ludoteca','p1', e.target.value)}
              className="mt-1 w-full px-3 py-2 border rounded" />
          </label>
          <label className="block">Paquete 2
            <input type="number" inputMode="decimal" step="any" min={0}
              defaultValue={membership.ludoteca.p2}
              key={membership.ludoteca.p2}
              onBlur={e => applyMembershipChange('ludoteca','p2', e.target.value)}
              className="mt-1 w-full px-3 py-2 border rounded" />
          </label>
        </div>

        <div>
          <h3 className="font-semibold mb-2">Reforzamiento</h3>
          <label className="block mb-2">Visita
            <input type="number" inputMode="decimal" step="any" min={0}
              defaultValue={membership.reforzamiento.visita}
              key={membership.reforzamiento.visita}
              onBlur={e => applyMembershipChange('reforzamiento','visita', e.target.value)}
              className="mt-1 w-full px-3 py-2 border rounded" />
          </label>
          <label className="block mb-2">MES x 12 visitas
            <input type="number" inputMode="decimal" step="any" min={0}
              defaultValue={membership.reforzamiento.m12}
              key={membership.reforzamiento.m12}
              onBlur={e => applyMembershipChange('reforzamiento','m12', e.target.value)}
              className="mt-1 w-full px-3 py-2 border rounded" />
          </label>
          <label className="block mb-2">MES x 15 visitas
            <input type="number" inputMode="decimal" step="any" min={0}
              defaultValue={membership.reforzamiento.m15}
              key={membership.reforzamiento.m15}
              onBlur={e => applyMembershipChange('reforzamiento','m15', e.target.value)}
              className="mt-1 w-full px-3 py-2 border rounded" />
          </label>
          <label className="block">MES x 20 visitas
            <input type="number" inputMode="decimal" step="any" min={0}
              defaultValue={membership.reforzamiento.m20}
              key={membership.reforzamiento.m20}
              onBlur={e => applyMembershipChange('reforzamiento','m20', e.target.value)}
              className="mt-1 w-full px-3 py-2 border rounded" />
          </label>
        </div>

        <div>
          <h3 className="font-semibold mb-2">Terapia de Lenguaje</h3>
          <label className="block mb-2">Individual
            <input type="number" inputMode="decimal" step="any" min={0}
              defaultValue={membership.terapia.individual}
              key={membership.terapia.individual}
              onBlur={e => applyMembershipChange('terapia','individual', e.target.value)}
              className="mt-1 w-full px-3 py-2 border rounded" />
          </label>
          <label className="block">8 visitas
            <input type="number" inputMode="decimal" step="any" min={0}
              defaultValue={membership.terapia.ocho}
              key={membership.terapia.ocho}
              onBlur={e => applyMembershipChange('terapia','ocho', e.target.value)}
              className="mt-1 w-full px-3 py-2 border rounded" />
          </label>
        </div>
      </div>
    </div>
  </section>
)}

        {tab === 'ludoteca' && (
          <ServicePOS
            title="Ludoteca"
            buttons={[
              { name: 'Visita 1-2 HRS', price: membership.ludoteca.v12 },
              { name: 'Visita 3-6 HRS', price: membership.ludoteca.v36 },
              { name: 'Paquete 1', price: membership.ludoteca.p1 },
              { name: 'Paquete 2', price: membership.ludoteca.p2 },
            ]}
            onSale={registerServiceSale}
          />
        )}

        {tab === 'reforzamiento' && (
          <ServicePOS
            title="Reforzamiento"
            buttons={[
              { name: 'Visita', price: membership.reforzamiento.visita },
              { name: 'MES x 12 visitas', price: membership.reforzamiento.m12 },
              { name: 'MES x 15 visitas', price: membership.reforzamiento.m15 },
              { name: 'MES x 20 visitas', price: membership.reforzamiento.m20 },
            ]}
            onSale={registerServiceSale}
          />
        )}

        {tab === 'terapia' && (
          <ServicePOS
            title="Terapia de Lenguaje"
            buttons={[
              { name: 'Individual', price: membership.terapia.individual },
              { name: '8 visitas', price: membership.terapia.ocho },
            ]}
            onSale={registerServiceSale}
          />
        )}

        {tab === "inventario" && (
          <section className="grid md:grid-cols-1 gap-6">
            {/* Crear producto */}
            <div className="bg-white rounded-2xl shadow p-4">
              <h2 className="text-lg font-semibold mb-3">Nuevo producto</h2>
              <NewProductForm onCreate={createProduct} />
            </div>

            {/* Movimientos de caja manuales */}
            <div className="bg-white rounded-2xl shadow p-4">
              <h2 className="text-lg font-semibold mb-3">Caja: ingresos/egresos</h2>
              <CashMoveForm onAdd={addMove} />
              <div className="mt-4 text-sm text-gray-600 space-y-1">
                <div>Ingresos manuales: <b>{mxn.format(totalIngresosManual)}</b></div>
                <div>Egresos: <b>{mxn.format(totalEgresos)}</b></div>
              </div>
            </div>

            {/* Lista inventario con QR */}
            <div className="bg-white rounded-2xl shadow p-4">
              <h2 className="text-lg font-semibold mb-3">Inventario</h2>
              <table className="w-full text-sm">
                <thead className="text-left text-gray-500"><tr><th>Producto</th><th>Precio</th><th>Stock</th><th>Reabastecer</th><th>QR</th><th></th></tr></thead>
                <tbody>
                  {inventory.map(p => (
                    <tr key={p.id} className="border-t">
                      <td className="py-2 font-medium">{p.name}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <input type="number" inputMode="decimal" step="any" min={0} value={p.price} onChange={e => updatePrice(p.id, Number(e.target.value))} className="w-24 px-2 py-1 border rounded" />
                          <span className="text-gray-500">{mxn.format(p.price)}</span>
                        </div>
                      </td>
                      <td>{p.stock}</td>
                      <td><ReplenishForm onAdd={(qty) => addStock(p.id, qty)} /></td>
                      <td><button className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200" onClick={() => setQrProduct(p)}>Ver QR</button></td>
                      <td><button className="text-red-600 hover:underline" onClick={() => removeProduct(p.id)}>Eliminar</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {tab === "cierre" && (
          <section className="grid md:grid-cols-2 gap-6">
            <div className="bg-white rounded-2xl shadow p-4">
              <h2 className="text-lg font-semibold mb-3">Resumen del día</h2>
              <div className="text-sm space-y-1">
                <div>Abierto desde: <b>{new Date(dayOpenedAt).toLocaleString('es-MX')}</b></div>
                <div>Caja inicial: <b>{mxn.format(startCash)}</b></div>
                <div>Ventas: <b>{mxn.format(totalVentas)}</b></div>
                <div>Ventas en caja: <b>{mxn.format(totalVentasCaja)}</b></div>
                <div>Ventas por transferencia: <b>{mxn.format(totalVentasTransfer)}</b></div>
                <div>Ingresos manuales: <b>{mxn.format(totalIngresosManual)}</b></div>
                <div>Egresos: <b>{mxn.format(totalEgresos)}</b></div>
                <div className="text-lg pt-2">Caja final: <b>{mxn.format(cashInRegister)}</b></div>
              </div>
              <div className="mt-4 flex gap-3">
                <button className="px-4 py-2 rounded bg-gray-100 hover:bg-gray-200" onClick={descargarCSVCierre}>Descargar CSV</button>
                <button className="px-4 py-2 rounded bg-orange-600 text-white hover:bg-orange-700" onClick={cerrarDia}>Cerrar día</button>
              </div>

              <div className="mt-6">
                <h3 className="font-semibold mb-2">Movimientos de caja</h3>
                <div className="max-h-64 overflow-auto text-sm divide-y">
                  {moves.length ? moves.map(m => (
                    <div key={m.id} className="py-2 flex items-center justify-between">
                      <div>
                        <div className="font-medium">{m.concept}</div>
                        <div className="text-gray-500">{new Date(m.ts).toLocaleString('es-MX')}</div>
                      </div>
                      <div className={m.type==='egreso'||m.type==='compra' ? 'text-red-600' : 'text-green-700'}>
                        {m.type==='egreso'||m.type==='compra' ? '-' : '+'} {mxn.format(m.amount)}
                      </div>
                    </div>
                  )) : <div className="text-gray-500">Sin movimientos manuales</div>}
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl shadow p-4">
              <h2 className="text-lg font-semibold mb-3">Objetos vendidos</h2>
              <table className="w-full text-sm">
                <thead className="text-left text-gray-500"><tr><th>Producto</th><th>Unidades</th><th>Ingresos</th></tr></thead>
                <tbody>
                  {resumenPorProducto.length ? resumenPorProducto.map(r => (
                    <tr key={r.name} className="border-t"><td className="py-2">{r.name}</td><td>{r.unidades}</td><td>{mxn.format(r.ingresos)}</td></tr>
                  )) : (<tr><td colSpan={3} className="py-6 text-center text-gray-500">Aún no hay ventas</td></tr>)}
                </tbody>
              </table>

              <div className="mt-6">
                <h3 className="font-semibold mb-2">Ventas</h3>
                <div className="max-h-64 overflow-auto text-sm divide-y">
                  {sales.length ? sales.map(s => (
                    <div key={s.id} className="py-2">
                      <div className="flex items-center justify-between">
                        <div className="font-medium">{new Date(s.ts).toLocaleString('es-MX')}</div>
                        <div>Total {mxn.format(s.total)} · Pago {mxn.format(s.paid)} · Cambio {mxn.format(s.change)} · Método {s.method === 'transferencia' ? 'Transferencia' : 'Caja'}</div>
                        {s.note ? <div className="text-xs text-gray-500">{s.note}</div> : null}
                      </div>
                      <ul className="list-disc ml-5 text-gray-600">
                        {s.items.map((it, idx) => (<li key={idx}>{it.name} × {it.qty} = {mxn.format(it.subtotal)}</li>))}
                      </ul>
                    </div>
                  )) : <div className="text-gray-500">Sin ventas registradas</div>}
                </div>
              </div>
            </div>
          </section>
        )}

        {tab === 'admin' && role === 'admin' && (
          <section className="grid gap-6">
            <div className="bg-white rounded-2xl shadow p-4">
              <h2 className="text-lg font-semibold mb-3">Administración de ventas</h2>
              <p className="text-sm text-gray-600 mb-3">Ajusta cantidades o elimina líneas. Los cambios actualizan ingresos y reponen inventario. No se registran en movimientos de caja.</p>
              <div className="space-y-4 max-h-[540px] overflow-auto">
                {sales.length ? sales.map(s => (
                  <div key={s.id} className="border rounded-xl p-3">
                    <div className="flex items-center justify-between text-sm">
                      <div className="font-medium">{new Date(s.ts).toLocaleString('es-MX')}</div>
                      <div>Método: {s.method === 'transferencia' ? 'Transferencia' : 'Caja'} · Total {mxn.format(s.total)} · Pago {mxn.format(s.paid)} · Cambio {mxn.format(s.change)}</div>
                    </div>
                    <table className="w-full text-sm mt-2">
                      <thead className="text-left text-gray-500"><tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th><th>Acciones</th></tr></thead>
                      <tbody>
                        {s.items.map((it) => (
                          <tr key={it.id} className="border-t">
                            <td className="py-2">{it.name}</td>
                            <td>{it.qty}</td>
                            <td>{mxn.format(it.price)}</td>
                            <td>{mxn.format(it.subtotal)}</td>
                            <td className="space-x-2">
                              <button className="px-2 py-1 text-xs rounded bg-gray-100 hover:bg-gray-200" onClick={() => adminChangeItemQty(s.id, it.id, Math.max(0, it.qty - 1))}>-1</button>
                              <button className="px-2 py-1 text-xs rounded bg-red-600 text-white hover:bg-red-700" onClick={() => adminChangeItemQty(s.id, it.id, 0)}>Eliminar línea</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-2 text-right">
                      <button className="px-3 py-1 rounded bg-red-50 hover:bg-red-100 text-red-700" onClick={() => adminDeleteSale(s.id)}>Eliminar venta</button>
                    </div>
                  </div>
                )) : <div className="text-gray-500">No hay ventas para administrar</div>}
              </div>
            </div>
          </section>
        )}

        {tab === 'bitacora' && (
          <Bitacora sales={sales} moves={moves} descargarCSV={descargarCSV} onConsolidate={consolidateMonth} />
        )}
      </main>

      {/* Modal QR */}
      {qrProduct && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4" onClick={() => setQrProduct(null)}>
          <div className="bg-white rounded-2xl p-4 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold">QR · {qrProduct.name}</div>
              <button className="text-gray-500 hover:text-black" onClick={() => setQrProduct(null)}>✕</button>
            </div>
            <div className="text-sm text-gray-600 mb-2">El QR codifica solo el <b>ID</b>. Nombre y precio se leen del inventario al escanear.</div>
            <div className="flex items-center justify-center min-h-[260px]">
              {qrDataUrl ? <img src={qrDataUrl} alt="qr" className="w-64 h-64" /> : <div className="text-sm text-gray-500">Generando...</div>}
            </div>
            {qrDataUrl && (
              <a href={qrDataUrl} download={`QR_${qrProduct.name}.png`} className="mt-3 block text-center px-4 py-2 rounded bg-gray-900 text-white hover:bg-black">Descargar PNG</a>
            )}
          </div>
        </div>
      )}

      <footer className="mx-auto max-w-6xl px-4 pb-8 text-xs text-gray-500">
        Tip: Para un egreso por compra de inventario, registra el egreso en "Caja".
      </footer>
      </>)}
    </div>
  );
}

function NewProductForm({ onCreate }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState(""); // string para permitir campo vacío
  const [stock, setStock] = useState(""); // string para permitir campo vacío
  return (
    <div className="grid gap-3">
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Nombre"
        className="px-3 py-2 border rounded"
      />

      <input
        type="number"
        inputMode="decimal"
        step="any"
        min={0}
        value={price}
        onChange={e => setPrice(e.target.value)}
        placeholder="Precio"
        className="px-3 py-2 border rounded"
      />

      <input
        type="number"
        inputMode="numeric"
        pattern="[0-9]*"
        step="1"
        min={0}
        value={stock}
        onChange={e => setStock(e.target.value)}
        placeholder="Cantidad en stock"
        className="px-3 py-2 border rounded"
      />

      <button
        className="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
        onClick={() => {
          const priceNum = Number(price || 0);
          const stockNum = Number(stock || 0);
          onCreate(name.trim(), priceNum, stockNum);
          setName("");
          setPrice("");
          setStock("");
        }}
      >
        Crear
      </button>
    </div>
  );
}

function ReplenishForm({ onAdd }) {
  const [qty, setQty] = useState(0);
  return (
    <div className="flex items-center gap-2">
      <input type="number" inputMode="numeric" pattern="[0-9]*" step="1" min={0} value={qty} onChange={e => setQty(Number(e.target.value || 0))} className="w-20 px-2 py-1 border rounded" placeholder="Cant." />
      <button className="px-3 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => { onAdd(qty); setQty(0); }}>Sumar</button>
    </div>
  );
}

function CashMoveForm({ onAdd }) {
  const [type, setType] = useState('ingreso');
  const [concept, setConcept] = useState('');
  const [amount, setAmount] = useState(0);
  return (
    <div className="grid md:grid-cols-4 gap-2 items-end">
      <select value={type} onChange={e => setType(e.target.value)} className="px-3 py-2 border rounded">
        <option value="ingreso">Ingreso</option>
        <option value="egreso">Egreso</option>
      </select>
      <input value={concept} onChange={e => setConcept(e.target.value)} placeholder="Concepto" className="px-3 py-2 border rounded md:col-span-2" />
      <input type="number" inputMode="decimal" step="any" min={0} value={amount} onChange={e => setAmount(Number(e.target.value || 0))} placeholder="$" className="px-3 py-2 border rounded" />
      <button className="px-4 py-2 rounded bg-gray-900 text-white hover:bg-black md:col-span-4" onClick={() => { onAdd(type, concept.trim(), amount); setConcept(''); setAmount(0); }}>Registrar</button>
    </div>
  );
}

function Bitacora({ sales, moves, descargarCSV, onConsolidate }) {
  const [range, setRange] = useState('dia'); // dia | semana | mes
  const now = new Date();
  const start = useMemo(() => {
    const d = new Date(now);
    if (range === 'dia') { d.setHours(0,0,0,0); return d; }
    if (range === 'semana') { const day = d.getDay(); const diff = (day === 0 ? 6 : day - 1); d.setDate(d.getDate()-diff); d.setHours(0,0,0,0); return d; }
    // mes
    d.setDate(1); d.setHours(0,0,0,0); return d;
  }, [range]);

  const filteredSales = useMemo(() => sales.filter(s => new Date(s.ts) >= start), [sales, start]);
  const filteredMoves = useMemo(() => moves.filter(m => new Date(m.ts) >= start), [moves, start]);

  const totales = useMemo(() => {
    let ventas=0, caja=0, transf=0, tickets=0;
    for (const s of filteredSales) { ventas += s.total; tickets++; if (s.method==='transferencia') transf += s.total; else caja += s.total; }
    return { ventas, caja, transf, tickets };
  }, [filteredSales]);

  const exportar = () => {
    const rows = [
      ['Fecha', 'Método', 'Total', 'Pago', 'Cambio'],
      ...filteredSales.map(s => [new Date(s.ts).toLocaleString('es-MX'), s.method, s.total.toFixed(2), s.paid.toFixed(2), s.change.toFixed(2)]),
      [], ['Totales','', totales.ventas.toFixed(2), '', ''], ['Caja','', totales.caja.toFixed(2),'',''], ['Transferencias','', totales.transf.toFixed(2),'',''], ['Tickets','', String(totales.tickets),'','']
    ];
    descargarCSV(rows, `bitacora_${range}`);
  };

  return (
    <section className="bg-white rounded-2xl shadow p-4">
      <h2 className="text-lg font-semibold mb-3">Bitácora de ventas</h2>
      <div className="flex items-center gap-3 mb-3">
        <select value={range} onChange={e => setRange(e.target.value)} className="px-3 py-2 border rounded">
          <option value="dia">Hoy</option>
          <option value="semana">Esta semana</option>
          <option value="mes">Este mes</option>
        </select>
        <button className="px-3 py-2 rounded bg-gray-900 text-white hover:bg-black" onClick={exportar}>Exportar CSV</button>
        {range==='mes' && (filteredSales.length || filteredMoves.length) ? (
          <button className="px-3 py-2 rounded bg-orange-600 text-white hover:bg-orange-700" onClick={() => onConsolidate && onConsolidate(start)}>Consolidar mes</button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <div className="p-3 rounded bg-gray-50">Tickets: <b>{totales.tickets}</b></div>
        <div className="p-3 rounded bg-gray-50">Ventas: <b>{mxn.format(totales.ventas)}</b></div>
        <div className="p-3 rounded bg-gray-50">Caja: <b>{mxn.format(totales.caja)}</b></div>
        <div className="p-3 rounded bg-gray-50">Transfer.: <b>{mxn.format(totales.transf)}</b></div>
      </div>
      <div className="mt-4 max-h-[420px] overflow-auto text-sm divide-y">
        {filteredSales.length ? filteredSales.map(s => (
          <div key={s.id} className="py-2 flex items-center justify-between">
            <div>
              <div className="font-medium">{new Date(s.ts).toLocaleString('es-MX')}</div>
              <div className="text-gray-500">{s.items.map(i => `${i.name}×${i.qty}`).join(', ')}</div>
            </div>
            <div>{s.method==='transferencia'?'Transf.':'Caja'} · {mxn.format(s.total)}</div>
          </div>
        )) : <div className="text-gray-500">Sin ventas en el rango seleccionado</div>}
      </div>
    </section>
  );
}

function ServicePOS({ title, buttons, onSale }) {
  const [items, setItems] = useState([]); // {name, price, qty}
  const [discountStr, setDiscountStr] = useState(''); // % como texto, vacío cuenta como 0
  const [discountConcept, setDiscountConcept] = useState('');
  const [method, setMethod] = useState('caja');
  const [paid, setPaid] = useState('');

  const addItem = (btn) => {
    setItems(prev => {
      const idx = prev.findIndex(i => i.name === btn.name);
      if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], qty: next[idx].qty + 1 }; return next; }
      return [...prev, { name: btn.name, price: btn.price, qty: 1 }];
    });
  };
  const removeItem = (name) => setItems(prev => prev.filter(i => i.name !== name));

  const totalBruto = useMemo(() => items.reduce((s,i)=> s + i.price * i.qty, 0), [items]);
  const totalNeto = useMemo(() => {
    const d = Number(discountStr || 0);
    return Math.max(0, totalBruto * (1 - d/100));
  }, [totalBruto, discountStr]);
  const change = useMemo(() => computeChange(paid, totalNeto), [paid, totalNeto]);

  const cobrarServicio = () => {
    if (!items.length) return;
    const paidNum = Number(paid);
    const d = Number(discountStr || 0);
    if (isNaN(paidNum) || paidNum < totalNeto) return;
    onSale && onSale({
      method,
      items,
      total: totalNeto,
      paid: paidNum,
      note: d > 0 ? `Descuento ${d}%: ${discountConcept}` : ''
    });
    setItems([]); setDiscountStr(''); setDiscountConcept(''); setPaid(''); setMethod('caja');
  };

  return (
    <section className="grid md:grid-cols-2 gap-6">
      <div className="bg-white rounded-2xl shadow p-4">
        <h2 className="text-lg font-semibold mb-3">{title}</h2>
        <div className="grid grid-cols-2 gap-3">
          {buttons.map((b,idx) => (
            <button key={idx} className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700" onClick={() => addItem(b)}>
              {b.name} · {mxn.format(b.price)}
            </button>
          ))}
        </div>
        <div className="mt-4 text-sm text-gray-600">Haz clic para sumar. Cada clic añade 1 unidad.</div>
      </div>

      <div className="bg-white rounded-2xl shadow p-4">
        <h3 className="text-lg font-semibold mb-3">Resumen</h3>
        <div className="max-h-[300px] overflow-auto">
          {items.length ? (
            <table className="w-full text-sm">
              <thead className="text-left text-gray-500"><tr><th>Concepto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th><th></th></tr></thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.name} className="border-t">
                    <td className="py-2">{it.name}</td>
                    <td>{it.qty}</td>
                    <td>{mxn.format(it.price)}</td>
                    <td>{mxn.format(it.price * it.qty)}</td>
                    <td><button className="text-red-600 hover:underline" onClick={() => removeItem(it.name)}>Quitar</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="text-sm text-gray-500">Agrega conceptos</div>}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-3 items-end">
          <div>
            <label className="text-sm text-gray-500">Descuento %</label>
            <input
              type="number"
              inputMode="numeric"
              pattern="[0-9]*"
              step="1"
              min={0}
              max={100}
              value={discountStr}
              onChange={e => setDiscountStr(e.target.value)}
              placeholder="0"
              className="w-full px-3 py-2 border rounded"
            />
          </div>
          <div>
            <label className="text-sm text-gray-500">Método</label>
            <select value={method} onChange={e => setMethod(e.target.value)} className="w-full px-3 py-2 border rounded">
              <option value="caja">Caja</option>
              <option value="transferencia">Transferencia</option>
            </select>
          </div>
          <div>
            <label className="text-sm text-gray-500">Pagó con</label>
            <input type="number" inputMode="decimal" step="any" value={paid} onChange={e => setPaid(e.target.value)} className="w-full px-3 py-2 border rounded" />
          </div>

          {Number(discountStr || 0) > 0 && (
            <div className="col-span-3">
              <label className="text-sm text-gray-500">Concepto</label>
              <input value={discountConcept} onChange={e => setDiscountConcept(e.target.value)} placeholder="Motivo del descuento" className="w-full px-3 py-2 border rounded" />
            </div>
          )}
        </div>

        <div className="mt-4 text-lg">
          <div className="flex items-center justify-between"><span>Total bruto</span><b>{mxn.format(totalBruto)}</b></div>
          <div className="flex items-center justify-between"><span>Total neto</span><b>{mxn.format(totalNeto)}</b></div>
          <div className="flex items-center justify-between"><span>Cambio</span><b>{mxn.format(change)}</b></div>
        </div>

        <div className="mt-4 flex gap-3">
          <button className="px-4 py-2 rounded bg-green-600 text-white hover:bg-green-700" onClick={cobrarServicio} disabled={!items.length || Number(paid) < totalNeto}>Cobrar</button>
          <button className="px-4 py-2 rounded bg-gray-100 hover:bg-gray-200" onClick={() => { setItems([]); setDiscountStr(''); setDiscountConcept(''); setPaid(''); }}>Vaciar</button>
        </div>
      </div>
    </section>
  );
}
function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { setErr('Credenciales inválidas'); return; }
    const user = data.user;
    const { data: prof } = await supabase.from('profiles').select('name, role').eq('id', user.id).single();
    onLogin && onLogin({ email: user.email, role: prof?.role ?? 'trabajador', name: prof?.name ?? '', id: user.id });
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-2xl shadow p-6 space-y-3">
        <h1 className="text-xl font-bold text-center mb-1">LudoBlack</h1>
        <div className="text-sm text-gray-600 text-center mb-4">Inicia sesión para continuar</div>
        <label className="block text-sm">Correo
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} className="mt-1 w-full px-3 py-2 border rounded" required />
        </label>
        <label className="block text-sm">Contraseña
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="mt-1 w-full px-3 py-2 border rounded" required />
        </label>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <button type="submit" className="w-full px-4 py-2 rounded bg-gray-900 text-white hover:bg-black">Iniciar sesión</button>
      </form>
    </div>
  );
}
