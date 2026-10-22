# 动效的离线核验

渲染测试（`test/client.ts`）只能测结构：类名、`is-open`、折完就卸载。曲线好不好、转场有没有真的排上，得在浏览器里看。

```sh
node build-preview.mjs          # 从 ../../dist/client.js 抽出插件自己的 CSS，拼出 preview.html
chromium --headless=new --disable-gpu --no-sandbox --virtual-time-budget=3000 --dump-dom preview.html
```

`preview.html` 底部那行输出就是判据：折叠块收起时高度必须是 0，展开 / 收起时必须各有一条 `height/200ms` 转场，`finish()` 之后的高度必须是 60 / 0。

**注意**：headless 的虚拟时间会把转场冻在起点（`getAnimations()` 里有、但 `currentTime` 不走）。所以只能查「有没有这条转场」+ 用 `finish()` 跳到最后看终点值；中间帧要在真浏览器里看，别拿 `setTimeout` 采样——那量到的永远是起点。

要截图就把 `--dump-dom` 换成 `--screenshot=shot.png --window-size=820,1000`；脚本最后会把折叠留在展开态。
