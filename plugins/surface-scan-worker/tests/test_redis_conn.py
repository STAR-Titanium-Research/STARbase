"""REDIS_URL (with a password) wins; REDIS_HOST/REDIS_PORT remain the fallback."""

from app.lib import redis_conn


def test_url_preferred(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://:pw@cache.internal:6380/2")
    monkeypatch.setenv("REDIS_HOST", "ignored")
    monkeypatch.setenv("REDIS_PORT", "1")
    assert redis_conn.redis_url() == "redis://:pw@cache.internal:6380/2"
    kw = redis_conn.get_redis().connection_pool.connection_kwargs
    assert kw["password"] == "pw"
    assert kw["host"] == "cache.internal"
    assert kw["port"] == 6380
    assert kw["db"] == 2


def test_host_port_fallback(monkeypatch):
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.setenv("REDIS_HOST", "r1")
    monkeypatch.setenv("REDIS_PORT", "6400")
    assert redis_conn.redis_url() == "redis://r1:6400"
    kw = redis_conn.get_redis().connection_pool.connection_kwargs
    assert (kw["host"], kw["port"]) == ("r1", 6400)
    assert kw.get("password") is None


def test_blank_url_falls_back(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "  ")
    monkeypatch.delenv("REDIS_HOST", raising=False)
    monkeypatch.delenv("REDIS_PORT", raising=False)
    assert redis_conn.redis_url() == "redis://redis:6379"
