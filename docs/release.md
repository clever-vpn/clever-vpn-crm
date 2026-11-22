# 发布与版本（云服务只有一个对外版本）

> 线上跑的就是**最新 tag**；tag 单调递增，指向"所有 worker 都部署成功"的那个 commit。
> 自动发布只 bump patch；minor/major 必须显式指定（见「大版本」）。

## 部署的 tag 规则

每个 deploy workflow（`deploy-saas-shard` / `deploy-saas-router` / `deploy-saas-site` /
`deploy`）都有一个可选的 `tag` 输入：

| 输入 | 行为 |
|---|---|
| 传了 tag 且存在 | 部署该 tag 的 commit |
| 传了 tag 但不存在 | **部署直接失败** |
| 没传，HEAD == 最新 release 的 tag commit | 复用该 tag |
| 没传，HEAD ≠ 最新 release | 最新 release 的 patch+1，部署 HEAD；成功后创建 tag + release |

实现：`_release-tag.yml`（解析，输出 `release_tag` / `is_new_tag` / `sha`）与
`_release-publish.yml`（部署成功后创建 tag+release，幂等）。部署一律 checkout
解析出的 `sha`，`CRM_CODE_VERSION` / `PLATFORM_VERSION` 注入该 tag。

## 常规发布（patch）

```bash
gh workflow run deploy-saas-shard.yml            # 空 tag = 自动解析
gh workflow run deploy-saas-router.yml           # HEAD 已发布 ⇒ 复用同一 tag
gh workflow run deploy-saas-site.yml
```

顺序：**shard → router → site**。三者必须自报同一个版本（`/__version`、`/__site/version`）。

## 大版本 / minor

**大版本变化时，先手动创建新的 tag，然后 release 这个 tag，再用这个 tag 来部署。**

```bash
git switch main && git pull --ff-only
git tag v2.0.0 && git push origin v2.0.0
gh release create v2.0.0 --title v2.0.0 --generate-notes

gh workflow run deploy-saas-shard.yml  -f tag=v2.0.0
gh workflow run deploy-saas-router.yml -f tag=v2.0.0
gh workflow run deploy-saas-site.yml   -f tag=v2.0.0
```

## 维护类部署（扩容 / 重平衡）

`ensure-shard` 与 `rebalance-shards` 只允许部署**最新已发布版本**（`_release-tag.yml`
的 `mode: latest`），不会因为 main 上未发布的提交而造出新 tag。

## 验证

| 检查 | 期望 |
|---|---|
| `gh release list -L 1` | 最新 tag = 本次版本 |
| `curl https://<slug>.clever-panel.win/__version` | `code == tag` |
| `curl https://origin-crm.clever-vpn.org/__version` | `version == tag` |
| `curl https://origin-site.clever-vpn.org/__site/version` | `platform == tag` |
| `gh run view <id> --log` | 无 ERROR |

## 反模式

- 本地 `wrangler deploy` 绕过 CI；
- 部署不存在的 tag（规则要求失败，不要改成自动创建）；
- 给已部署但未发布的 commit 补 tag；
- 只发 shard 就宣布发布完成。
