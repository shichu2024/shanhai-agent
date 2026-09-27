// WP-6B 批次三测试夹具：模拟 resume 子进程——打印 argv 与环境关键值到 stdout/stderr 后退出（node 直启，Windows 平台事实）。
console.log('argv=' + JSON.stringify(process.argv.slice(2)));
console.log('cwd=' + process.cwd());
console.error('stderr-probe');
process.exit(0);
