// Lightweight in-memory TTL cache for high-traffic static/semi-static data
// Reduces MongoDB Atlas read queries and hosting CPU/RAM load

const cache = new Map();

function get(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiry) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function set(key, data, ttlSeconds = 300) {
  cache.set(key, {
    data,
    expiry: Date.now() + ttlSeconds * 1000,
  });
}

function del(key) {
  cache.delete(key);
}

function delPrefix(prefix) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

function clear() {
  cache.clear();
}

module.exports = {
  get,
  set,
  del,
  delPrefix,
  clear,
};
