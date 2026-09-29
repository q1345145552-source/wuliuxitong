/**
 * 单张图片（base64）的上限和中文提示（2026-09-29 老板选 A）。
 *
 * 线上请求走 nginx → Next 转发 → 接口，**Next 转发那一跳的请求体上限是 10 MiB**，
 * 图片 base64 放在 JSON 里；整个请求超过 1040 万字节的根本到不了接口，会卡 30 秒报英文 500 ——
 * 前端 core-api.ts 的 REQUEST_BODY_MAX_BYTES 在发之前就挡。单张图这里收到 950 万字（原图约 7MB），比前端那道低一截，
 * 所以单张图超了看到的是下面这句（接口给的），整批超了看到的是前端那句。
 * 这里是接口自己的那道闸：入库照片 / 签收单、运单产品图用它（原来一个 400 万字 + 英文，一个 2000 万字 + 英文）。
 */
export const UPLOAD_IMAGE_MAX_BASE64 = 9_500_000;

export function uploadTooLargeMessage(base64Length: number): string {
  const mb = ((base64Length * 3) / 4 / 1024 / 1024).toFixed(1);
  return `图片太大了（约 ${mb} MB），传不上去。请压缩到 6MB 以内再传。`;
}
