/** Mutation tracking at the queue boundary, not an updatedAt heuristic. Only
 * changed item payloads are copied. All mutable queue references after installing
 * this tracker must be obtained through .state; preexisting raw aliases require
 * an explicit caller-owned compatibility bridge during a live migration.
 */
export function createQueueStateTracker(initialState) {
  const rawByProxy = new WeakMap();
  const itemProxies = new Map();
  const rows = new Map();
  let dirtyIds = new Set();
  let deletedIds = new Set();
  let dirtyBindings = new Set();
  let orderDirty = false;
  const raw = initialState;

  const unwrap = (value) => value && typeof value === 'object' ? rawByProxy.get(value) || value : value;
  function copy(value, seen = new Map()) {
    value = unwrap(value);
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (seen.has(value)) return seen.get(value);
    const output = Array.isArray(value) ? [] : {};
    seen.set(value, output);
    for (const key of Object.keys(value)) {
      Object.defineProperty(output, key, { value: copy(value[key], seen), enumerable: true, writable: true, configurable: true });
    }
    return output;
  }
  function validateItem(value) {
    const item = unwrap(value);
    if (!item || typeof item.id !== 'string' || !item.id) throw new TypeError('Tracked queue item needs a stable id');
    return item;
  }
  function mark(id) { if (rows.has(id)) { dirtyIds.add(id); deletedIds.delete(id); } }
  function wrapItem(value) {
    const item = validateItem(value);
    let cache = itemProxies.get(item.id);
    if (!cache || cache.item !== item) {
      cache = { item, proxies: new WeakMap() };
      itemProxies.set(item.id, cache);
    }
    const id = item.id;
    function wrap(nested) {
      nested = unwrap(nested);
      if (!nested || typeof nested !== 'object' || nested instanceof Date) return nested;
      if (cache.proxies.has(nested)) return cache.proxies.get(nested);
      const proxy = new Proxy(nested, {
        get: (target, key, receiver) => wrap(Reflect.get(target, key, receiver)),
        set(target, key, next) {
          next = unwrap(next);
          if (target === item && key === 'id' && next !== id) throw new Error('Queue item stable id cannot change');
          if (!Object.is(target[key], next)) { Reflect.set(target, key, next); mark(id); }
          return true;
        },
        deleteProperty(target, key) { if (Object.hasOwn(target, key)) { Reflect.deleteProperty(target, key); mark(id); } return true; },
        defineProperty(target, key, descriptor) {
          if (target === item && key === 'id' && descriptor.value !== id) throw new Error('Queue item stable id cannot change');
          Reflect.defineProperty(target, key, descriptor); mark(id); return true;
        },
      });
      cache.proxies.set(nested, proxy); rawByProxy.set(proxy, nested);
      return proxy;
    }
    return wrap(item);
  }
  function replaceItems(values, { initial = false } = {}) {
    const nextRows = new Map();
    const next = values.map((value) => {
      const item = validateItem(value);
      if (nextRows.has(item.id)) throw new Error(`Duplicate queue item id: ${item.id}`);
      nextRows.set(item.id, item);
      return item;
    });
    if (!initial) {
      for (const [id, item] of nextRows) if (rows.get(id) !== item) dirtyIds.add(id);
      for (const id of rows.keys()) if (!nextRows.has(id)) { deletedIds.add(id); dirtyIds.delete(id); }
      orderDirty = true;
    }
    rows.clear(); for (const [id, item] of nextRows) { rows.set(id, item); deletedIds.delete(id); }
    raw.items = next;
  }
  replaceItems(raw.items, { initial: true });

  const itemsProxy = new Proxy([], {
    get(_target, key) {
      const items = raw.items;
      if (key === 'push') return (...values) => {
        for (const value of values) {
          const item = validateItem(value);
          if (rows.has(item.id)) throw new Error(`Duplicate queue item id: ${item.id}`);
          items.push(item); rows.set(item.id, item); mark(item.id);
        }
        return items.length;
      };
      if (key === 'splice') return (...args) => {
        const next = items.slice();
        const removed = next.splice(...args.map((value, index) => index < 2 ? value : unwrap(value)));
        replaceItems(next); return removed.map(wrapItem);
      };
      if (['sort', 'reverse', 'shift', 'unshift', 'pop', 'copyWithin', 'fill'].includes(key)) return (...args) => {
        const next = items.slice(); const result = Array.prototype[key].apply(next, args.map(unwrap));
        replaceItems(next); return result === next ? itemsProxy : (result && typeof result === 'object' ? wrapItem(result) : result);
      };
      if (key === Symbol.iterator) return function* () { for (const item of items) yield wrapItem(item); };
      if (key === 'length') return items.length;
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) return items[key] === undefined ? undefined : wrapItem(items[key]);
      return Reflect.get(items, key);
    },
    set(_target, key, value) {
      const next = raw.items.slice(); next[key] = unwrap(value); replaceItems(next); return true;
    },
    has: (_target, key) => key in raw.items,
    ownKeys: () => Reflect.ownKeys(raw.items),
    getOwnPropertyDescriptor(_target, key) {
      if (key === 'length') return { value: raw.items.length, writable: true, enumerable: false, configurable: false };
      const descriptor = Object.getOwnPropertyDescriptor(raw.items, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
  rawByProxy.set(itemsProxy, raw.items);
  const bindingsProxy = new Proxy(raw.sessionBindings, {
    set(target, key, value) {
      if (typeof value !== 'string') throw new TypeError('Queue binding must be a string');
      if (!Object.hasOwn(target, key) || target[key] !== value) {
        Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
        dirtyBindings.add(key);
      }
      return true;
    },
    deleteProperty(target, key) { if (Object.hasOwn(target, key)) { Reflect.deleteProperty(target, key); dirtyBindings.add(key); } return true; },
  });
  rawByProxy.set(bindingsProxy, raw.sessionBindings);
  const state = new Proxy(raw, {
    get: (target, key) => key === 'items' ? itemsProxy : key === 'sessionBindings' ? bindingsProxy : target[key],
    set(target, key, value) {
      if (key === 'items') replaceItems(value);
      else if (key === 'sessionBindings') {
        const before = target.sessionBindings;
        for (const oldKey of Object.keys(before)) if (!Object.hasOwn(value, oldKey)) delete bindingsProxy[oldKey];
        for (const [newKey, sessionId] of Object.entries(value)) bindingsProxy[newKey] = sessionId;
      } else target[key] = value;
      return true;
    },
  });
  return {
    state,
    markItem: mark,
    snapshot: () => ({ items: raw.items.map((item) => copy(item)), sessionBindings: copy(raw.sessionBindings) }),
    takeChanges() {
      const upserts = [...dirtyIds].filter((id) => rows.has(id)).map((id) => copy(rows.get(id)));
      const bindingUpserts = {}; const bindingDeletes = [];
      for (const key of dirtyBindings) {
        if (Object.hasOwn(raw.sessionBindings, key)) Object.defineProperty(bindingUpserts, key, {
          value: raw.sessionBindings[key], enumerable: true, writable: true, configurable: true,
        });
        else bindingDeletes.push(key);
      }
      const changes = { upserts, deletedIds: [...deletedIds], bindingUpserts, bindingDeletes };
      if (orderDirty) changes.orderIds = raw.items.map((item) => item.id);
      dirtyIds = new Set(); deletedIds = new Set(); dirtyBindings = new Set(); orderDirty = false;
      return changes;
    },
    restoreChanges(changes) {
      for (const id of [...(changes.upserts || []).map((item) => item.id), ...(changes.deletedIds || [])]) {
        if (rows.has(id)) mark(id); else { deletedIds.add(id); dirtyIds.delete(id); }
      }
      for (const key of [...Object.keys(changes.bindingUpserts || {}), ...(changes.bindingDeletes || [])]) dirtyBindings.add(key);
      if (changes.orderIds) orderDirty = true;
    },
  };
}
