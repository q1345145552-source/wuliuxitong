# Clean Pytest — 测试规范

## 核心原则

1. **Fakes 替代 Mocks**
   - 不允许使用 `@patch`、`unittest.mock.MagicMock`、`mock.patch`
   - 必须为外部依赖写 Fake 假实现类（内存版，不走网络/数据库）
   - Fake 类命名：`Fake<OriginalClassName>`，放在 `tests/fakes.py`

2. **显式 AAA 结构**
   - 每个测试函数必须用注释标注三段：
     ```
     # Arrange
     # Act
     # Assert
     ```

3. **Fixture 注入依赖**
   - 用 `@pytest.fixture` 串联依赖
   - 一个 fixture 可以注入另一个 fixture
   - `conftest.py` 放全局 fixture

4. **契约测试**
   - 入口模块（Controller/MCP Tool 注册）必须写契约测试
   - 验证函数是否注册、参数签名是否正确

## 代码示例

```python
#### tests/fakes.py
class FakeUsersRepo:
    def __init__(self):
        self.users: dict[str, dict] = {}
        self.fail_on_upsert = False
    def upsert(self, uid: str, data: dict) -> None:
        if self.fail_on_upsert:
            raise RuntimeError("upsert failed (fake)")
        self.users[uid] = dict(data)
    def list(self, limit: int | None = None) -> list[dict]:
        items = list(self.users.values())
        return items[:limit] if limit else items

#### tests/conftest.py
@pytest.fixture
def fake_users_repo():
    return FakeUsersRepo()

@pytest.fixture
def user_env(fake_users_repo):
    from myapp.service import UserService
    return UserService(fake_users_repo), fake_users_repo

#### tests/test_user_service.py
def test_add_user_success(user_env):
    # Arrange
    svc, repo = user_env
    # Act
    result = svc.add_user("uid-1", email="a@b.com", name="Alice")
    # Assert
    assert result["status"] == "ok"
    assert "uid-1" in repo.users

def test_add_user_failure_rollback(user_env):
    # Arrange
    svc, repo = user_env
    repo.fail_on_upsert = True
    # Act & Assert
    with pytest.raises(RuntimeError):
        svc.add_user("uid-1", email="a@b.com", name="Alice")
```

## 反模式对照

| ❌ 不要 | ✅ 改成 |
|---------|---------|
| `@patch('module.func')` | 写一个 Fake 类 |
| `MagicMock(return_value=...)` | Fake 类里写真实逻辑 |
| 测试没有 AAA 注释 | 每段加 `# Arrange` / `# Act` / `# Assert` |
| 只测 happy path | 同时测 error path + 边界值 |
| 测试之间共享状态 | 每个测试用独立的 fixture 实例 |
