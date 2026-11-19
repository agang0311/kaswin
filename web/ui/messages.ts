/** User-facing wording for the rolling page. Display only: it never decides whether an action is allowed. */
import type {Round,Facts,Phase} from '../app/types.ts';
export const UNIT='TKAS';
/** Order = the order they are offered on the round page. `free` = no private key needed (the executor only supplies a reward address). */
export const ACTION_INFO: Record<string,{title:string;verb:string;free:boolean;desc:string}>={
  BUY:{title:'购买票',verb:'购买',free:false,desc:'票款进入合约，另付网络费。每满 256 笔购买，当前分片会自动封存，购买不受 256 笔上限限制。'},
  CLOSE:{title:'封盘',verb:'封盘',free:false,desc:'结束售票。达到最低票数进入开奖；不足则转入退款；无人购买则退还押金。任何人可操作，发起者付网络费。'},
  DRAW:{title:'开奖',verb:'开奖',free:false,desc:'用链上数据抽出中奖票，任何人都无法挑选或预测。需封盘后约 100 DAA（约 10 秒）。发起者付网络费。'},
  TIMEOUT:{title:'超时转退款',verb:'转入退款',free:false,desc:'封盘后约 12 小时仍无人开奖时，任何人可把本轮转入退款。'},
  PAY_OLD:{title:'派奖：处理已封存的分片',verb:'派奖',free:true,desc:'把前面已封存分片的票款并入奖金，一次最多 16 个分片。无需签名，任何人可执行，每个分片的执行者获得 1 TKAS 奖励。'},
  PAY_SELF:{title:'派奖：结算',verb:'派奖',free:true,desc:'把奖金付给中奖者，押金退还创建者。无需签名，任何人可执行并获得 1 TKAS 执行奖励。'},
  REFUND_OLD:{title:'退款：已封存的分片',verb:'退款',free:true,desc:'按购买记录批量退款，每批最多 32 条，每条扣 0.02 TKAS 执行费。无需签名，任何人可执行，执行费池扣除网络费后归执行者。'},
  REFUND_SELF:{title:'退款：当前分片',verb:'退款',free:true,desc:'退还当前分片里剩余购买记录和创建者押金。通常无需签名，任何人可执行。'},
};
export const ROLE_LABEL: Record<string,string>={MANAGER:'轮次状态（合约）',FROZEN:'已封存分片（合约）',WINNER:'中奖者',CREATOR:'创建者（押金退回）',EXECUTOR:'执行者奖励',
  BUYER_REFUND:'买家退款',CHANGE:'找零',REGISTRATION:'登记输出'};
export const TERMINAL_LABEL: Record<string,string>={PAID:'已派奖',EMPTY:'空轮结束',REFUNDED:'退款完成'};

/** Plain-language messages for failure codes. Unknown codes fall back to a generic line plus the code (never raw error text). */
const IMPORT_BAD='导入内容没有通过校验（数据被修改或已损坏），已拒绝，本机记录没有改动。';
const ERR: Record<string,string>={
  STALE_INPUT:'这一轮的状态已被别人推进，本机记录已过期。点击「刷新状态」即可自动追赶最新进度，或导入最新分享链接。',
  NODE_REQUIRED:'还没有连接到节点。请稍候，或在「高级设置」里检查节点地址。',
  NODE_DISCONNECTED:'节点连接断开了，请在「高级设置」里重新连接。',
  NO_NODE:'没有可用的节点。',
  SERVICE_REQUIRED:'预算服务还没有就绪。请稍候，或在「高级设置」里检查服务地址。',
  SERVICE_UNREACHABLE:'连不上预算服务，请稍后重试。',SERVICE_BUSY:'预算服务正忙，请几秒后重试。',BUSY:'预算服务正忙，请几秒后重试。',
  SERVICE_TIMEOUT:'预算服务响应超时，请重试。',SERVICE_ERROR:'预算服务返回了错误，请稍后重试。',
  WALLET_REQUIRED:'请先连接钱包。',WALLET_KEY_REQUIRED:'这一步需要能签名的钱包支付手续费，请连接 KasWare、Kastle 或 Kaspire。',WALLET_CLOSED:'钱包已断开，请重新连接。',
  WALLET_CHANGED:'钱包账户或网络已变化，原报价已失效，请重新连接并报价。',WALLET_NETWORK_MISMATCH:'请在扩展钱包中手动切换到当前页面对应的网络后重新连接。',
  MAINNET_MEMORY_KEY_DISABLED:'主网已禁用内存明文私钥，请使用 KasWare、Kastle 或 Kaspire 钱包。',
  WALLET_NOT_INSTALLED:'没有检测到所选钱包扩展，请安装或启用后刷新页面。',WALLET_UNSUPPORTED:'当前扩展版本缺少所需签名接口，请升级钱包后重试。',
  WALLET_NOT_AUTHORIZED:'钱包尚未授权本页访问账户。',WALLET_PUBLIC_KEY_MISMATCH:'钱包返回的公钥与账户地址不一致，已停止。',WALLET_SCHNORR_REQUIRED:'此协议需要 Schnorr 账户，请在钱包中换用 Schnorr 地址。',
  WALLET_CONNECT_TIMEOUT:'等待扩展钱包连接超时，请先在扩展中完成或拒绝原请求，再重试。',
  WALLET_REQUEST_REJECTED:'钱包没有完成授权或签名，请在扩展中确认后重试。',WALLET_SIGN_TIMEOUT:'等待扩展钱包签名超时，请先在扩展中完成或拒绝原请求，再重新操作。',
  WALLET_TRANSACTION_CHANGED:'钱包返回的交易内容与确认报价不一致，已拒绝发送。',WALLET_DRAFT_CHANGED:'签名期间报价发生变化，已停止发送，请重新报价。',
  WALLET_RESPONSE_INVALID:'钱包返回的交易数据格式不正确，已拒绝发送。',WALLET_EVENTS_UNAVAILABLE:'钱包状态通知不可用，请重新连接或升级扩展。',
  WALLET_FUNDS_INSUFFICIENT:'钱包里的余额不够支付这一笔（含网络费）。',
  WALLET_FUNDS_PENDING:'钱包里的资金正被另一笔还没确认的交易占用（可能是同一个钱包在别的页面、标签页或脚本里发出的）。等那笔确认后再试，一般几秒到一分钟。',
  KEY_FORMAT:'私钥格式不正确：需要 64 位十六进制。',KEY_INVALID:'这不是有效的私钥。',
  RECIPIENT_P2PK_REQUIRED:'收款地址必须是当前网络有效的 Schnorr 地址（kaspa:q… 或 kaspatest:q…）。',
  DURABLE_STORE_REQUIRED:'这个浏览器没有可用的本地存储，为避免“发出后没有记录”，已禁止发送。请换用普通（非隐私）窗口。',
  AMOUNT_FORMAT:'金额格式不正确（最多 8 位小数）。',QUANTITY:'数量不正确。',SETTINGS:'轮次参数不合法，请检查票价、票数和最低票数。',
  NOTHING_PREPARED:'没有待确认的交易，请重新操作。',
  INTENT_UNRESOLVED_REPLACEMENT_BLOCKED:'这一轮还有一笔交易没有确认结果，需要先处理它，才能发起新的操作。',
  IMPORT_WOULD_REPLACE_LOCAL_INTENT:'本机有一笔尚未确认的交易，导入会覆盖它。请先处理完这笔交易（或放弃它）再导入。',
  ROUND_NOT_FOUND:'找不到这一轮。',ROUND_HALTED:'这一轮已停止，需要人工核对后重新导入。',
  STATE_TEXT_SIZE:'导入内容太大。',STATE_PARSE:'导入内容无法解析，请确认是完整的分享链接或轮次数据。',STATE_BIGINT:'导入内容格式不正确。',STATE_BYTES:'导入内容格式不正确。',
  SHARE_FORMAT:'分享链接无法解析，请确认复制完整。',SHARE_EMPTY:'请先粘贴分享链接。',
  PRIZE_MIN:'这一轮的奖池太小，扣除执行奖励和网络费后不足以派奖。',PROTOCOL_FEE_CAP:'当前网络费用超过协议上限，请稍后重试。',FEE_CONVERGENCE:'暂时无法确定网络费，请稍后重试。',
  REGISTRY_ADDRESS:'登记地址无效：需要是当前网络有效的 Schnorr P2PK 或 P2SH 地址。',
  INDEXER_URL:'索引 API 地址不正确，需要不含用户名、查询参数和锚点的 http(s) 地址。',INDEXER_REQUIRED:'请先在高级设置连接 Rolling 索引。',
  INDEXER_DISCOVERY_LIMIT:'当前列表已加载较多轮次，请直接输入 CID 或交易 ID 查找。',
  INDEXER_SCOPE:'这个索引的网络或合约版本不匹配，请使用与当前网络一致的 Rolling 索引。',INDEXER_UNAVAILABLE:'索引暂时不可用，本机记录已保留，可稍后重试。',INDEXER_TIMEOUT:'索引响应超时，本机记录已保留。',
  INDEXER_STALE:'索引正在恢复或追赶链上状态，请稍后重试。',INDEXER_NOT_FOUND:'索引还未发现这个轮次或交易，请稍后重试，或导入分享链接。',
  INDEXER_RESPONSE_INVALID:'索引返回的数据格式不正确，已拒绝导入。',INDEXER_RESPONSE_SIZE:'索引返回的数据过大，已停止导入。',INDEXER_HEAD_NOT_FINAL:'索引的最新交易还未达到本页确认深度，请稍后重试。',
  INDEXER_HEAD_EFFECTS:'索引状态与节点中的实际交易不一致，已拒绝导入。',INDEXER_SETTINGS:'索引中的轮次规则与节点交易不一致，已拒绝导入。',INDEXER_HEAD_BINDING:'索引的最新交易与轮次记录不一致，已拒绝导入。',
  INDEXER_PENDING_STATE:'索引包含未完成或未确认状态，暂时不能导入。',INDEXER_TERMINAL:'节点交易未能证实索引所说的结算结果，已拒绝导入。',INDEXER_CONNECTION_CHANGED:'核对期间连接发生变化，请重试。',
  RPC_TIMEOUT:'节点响应超时，请重试。',SINK_BEHIND:'节点还没有同步到最新，请稍候再试。',
  DRAW_PROOF_MISSING:'开奖需要的链上证明还没有准备好，请稍后重试。',
  INTENT_TOO_RECENT:'这笔交易提交不到 3 分钟，请再等一会儿。',INTENT_IN_MEMPOOL:'这笔交易仍在节点内存池里，请等待确认。',
  INTENT_INPUTS_STILL_LIVE:'这笔交易的输入还没有被花掉，请使用「重新发送」而不是放弃。',INTENT_ACCEPTANCE_UNRESOLVED:'还不能确定这笔交易有没有被接受，请先刷新状态。',
  DISCARD_NOT_ALLOWED:'这笔交易现在不能放弃。',NO_PENDING_INTENT:'没有待处理的交易。',
  SEARCH_RANGE:'这笔交易提交得太久（约 11 小时以上），节点已无法回溯查询它是否被接受，页面没法自动判断。',
  NODE_URL_INVALID:'节点地址不正确：每行需要是 ws:// 或 wss:// 开头的完整地址。',NODE_URL_CREDENTIALS:'节点地址不能包含用户名或密码。',NODE_URL_COUNT:'节点地址最多填 8 行。',
  SERVICE_URL:'预算服务地址不正确：需要是不带用户名、查询参数和锚点的 http(s):// 地址。',
  NODE_NETWORK_MISMATCH:'这个节点不是 Testnet 10。',NODE_URLS_REQUIRED:'请至少填写一个节点地址。',CONNECT_TIMEOUT:'连接超时，请检查地址是否可达。',NODE_CLOSED:'节点连接已关闭。',
  ROUND_SCOPE:IMPORT_BAD,ROUND_RECEIPTS:IMPORT_BAD,ROUND_PENDING:IMPORT_BAD,PENDING_RECEIPT:IMPORT_BAD,PENDING_INTENT:IMPORT_BAD,ROUND_SETTINGS:IMPORT_BAD,ROUND_SHAPE:IMPORT_BAD,
  INTENT_SCOPE:IMPORT_BAD,INTENT_TXID:IMPORT_BAD,INTENT_CONTENT_CHANGED:IMPORT_BAD,INTENT_OUTPOINT:IMPORT_BAD,INTENT_FEE:IMPORT_BAD,INTENT_INPUT_COUNT:IMPORT_BAD,SIGNATURE_INVALID:IMPORT_BAD,
};
const codeOf=(e: unknown): unknown => typeof e==='string'?e:(e as {code?:unknown;message?:unknown}|null|undefined)?.code??(e as {message?:unknown}|null|undefined)?.message;
/** UserError (code 'USER') carries a designed, user-facing Chinese sentence (e.g. address checksum errors): show it instead of a bare code. */
const userMessage=(e: unknown): string|null=>{
  const m=(e as {code?:unknown;message?:unknown}|null|undefined);
  return m&&m.code==='USER'&&typeof m.message==='string'&&m.message.length<=120&&/[\u4e00-\u9fff]/.test(m.message)?m.message:null;
};
export function errText(e: unknown): string {
  const um=userMessage(e);if(um)return um;
  const code=codeOf(e);
  if(typeof code==='string'&&ERR[code])return ERR[code];
  return `操作没有完成（错误代码 ${typeof code==='string'&&/^[A-Z0-9_]{2,64}$/.test(code)?code:'UNKNOWN'}）。可在「高级设置」里查看日志。`;
}
export const errCode=(e: unknown): string=>{const c=codeOf(e);return typeof c==='string'&&/^[A-Z0-9_]{2,64}$/.test(c)?c:'UNKNOWN';};

/** Phase badge for a round record + its describeRound() facts. */
const TERMINAL_PHASE: Record<string,Phase>={PAID:{key:'paid',label:'已派奖',tone:'gold'},EMPTY:{key:'empty',label:'空轮结束',tone:'muted'},REFUNDED:{key:'refunded',label:'退款完成',tone:'muted'}};
const MODULE_PHASE: Record<string,Phase>={sales:{key:'open',label:'售票中',tone:'mint'},sealed:{key:'sealed',label:'待开奖',tone:'violet'},win:{key:'paying',label:'派奖中',tone:'gold'},
  refund:{key:'refund',label:'退款中',tone:'amber'}};
export function phaseOf(r: Pick<Round,'halted'|'terminal'|'manager'>,f: Pick<Facts,'module'>|null|undefined): Phase {
  if(r.halted)return {key:'halted',label:'已停止',tone:'amber'};
  if(r.terminal)return TERMINAL_PHASE[r.terminal]??{key:'done',label:String(r.terminal),tone:'muted'};
  if(!r.manager)return {key:'new',label:'等待创建确认',tone:'amber'};
  return MODULE_PHASE[f?.module??'']??{key:'new',label:'读取中',tone:'amber'};
}
export const CLOSE_PRESETS: [string,string][]=[['10','10 分钟'],['30','30 分钟'],['60','1 小时'],['360','6 小时'],['1440','24 小时'],['custom','自定义']];
