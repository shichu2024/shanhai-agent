# T3 阳性对照夹具（批次四 DoD-②/P2-4）

每族一个样本：密钥族（positive-control.secret.txt）/ 扩展名族（.gguf）/ 魔数族（renamed-weight.dat）/ safetensors 结构族（.safetensors）。
豁免入配置（src/scripts/releaseScan.ts DEFAULT_SCAN_CONFIG.exemptions，可审计）；scanForRelease(夹具目录, 无豁免配置) 必须全命中（测试锁定）。
