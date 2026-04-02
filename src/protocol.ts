// Razz protocol opcodes and types for the MCP server.
// Sourced from @razz/shared - regenerate with: npm run sync-protocol
// This file makes the MCP server self-contained (no monorepo dependency).
// AUTO-GENERATED - do not edit manually.

// Client → Server opcodes
// Using const objects instead of enums so minifiers can inline numeric values
// and strip human-readable names from the production bundle.
export const ClientOp = {
  Authenticate: 1,
  SendMessage: 10,
  EditMessage: 11,
  DeleteMessage: 12,
  AddReaction: 13,
  RemoveReaction: 14,
  JoinRoom: 20,
  LeaveRoom: 21,
  StartTyping: 30,
  StopTyping: 31,
  LoadHistory: 40,
  SearchMessages: 41,
  LoadReplies: 42,
  SendDM: 50,
  LoadDMList: 51,
  LoadDMHistory: 52,
  EditDM: 53,
  MuteDM: 54,
  DeleteDM: 55,
  DMTyping: 56,
  PinMessage: 80,
  UnpinMessage: 81,
  LoadPinned: 82,
  CreateRoomPoll: 83,
  VoteRoomPoll: 84,
  KickUser: 100,
  BanUser: 101,
  MuteUser: 102,
  UpdateRoomSettings: 110,
  TransferRoom: 111,
  PromoteMod: 112,
  DemoteMod: 113,
  PromoteTeam: 117,
  DemoteTeam: 118,
  SetRoomTopic: 114,
  SetSlowmode: 115,
  SetAnnouncement: 116,
  BrowseRooms: 120,
  SyncUnreadCounts: 133,
  MarkRoomRead: 134,
  ReportContent: 140,
  LoadReports: 141,
  LoadModLog: 142,
  UnbanUser: 143,
  UnmuteUser: 144,
  LoadTeamMembers: 145,
  GlobalBanUser: 146,
  GlobalUnbanUser: 147,
  BlockDM: 160,
  UnblockDM: 161,
  UpdateDMPrivacy: 162,
  LoadUserSettings: 163,
  UpdateAgentSettings: 164,
  AddDMReaction: 57,
  RemoveDMReaction: 58,
  MarkDMRead: 59,
  Rain: 180,
  Tip: 182,
  DismissWelcome: 184,
  ResetWelcome: 185,
  GamePlay: 186,
  GameAction: 187,
  PinDM: 195,
  UnpinDM: 196,
  LoadPinnedDMs: 197,
  LoadThread: 198,
  Heartbeat: 199,
  UpdatePresence: 200,
  // Balance & Betting
  GetBalance: 210,
  RequestDeposit: 211,
  RequestWithdraw: 212,
  GetLeaderboard: 213,
  // Spectator & Staking
  PlaceStake: 220,
  CancelStake: 221,
  GetMatchInfo: 222,
  GetAgentStats: 224,
  GetMatchHistory: 225,
  // Spectator Queue
  JoinSpectatorQueue: 230,
  LeaveSpectatorQueue: 231,
  GetQueueStatus: 232,
  // Agent query
  GetCrashRooms: 240,
  GetMyQueue: 241,
  // HexWar
  HexWarAction: 260,
  GetHexWarState: 261,
  JoinHexWarQueue: 262,
  LeaveHexWarQueue: 263,
  GetHexWarRooms: 264,
  // Live Feed
  GetLiveFeed: 270,
} as const;
export type ClientOp = (typeof ClientOp)[keyof typeof ClientOp];

// Server → Client opcodes
export const ServerOp = {
  Ready: 1,
  Error: 2,
  NewMessage: 10,
  MessageEdited: 11,
  MessageDeleted: 12,
  ReactionAdded: 13,
  ReactionRemoved: 14,
  UserJoined: 20,
  UserLeft: 21,
  TypingStart: 30,
  TypingStop: 31,
  History: 40,
  SearchResults: 41,
  RepliesData: 42,
  NewDM: 50,
  DMList: 51,
  DMHistory: 52,
  DMEdited: 53,
  DMMuted: 54,
  DMDeleted: 55,
  DMTypingIndicator: 56,
  MessagePinned: 80,
  MessageUnpinned: 81,
  PinnedMessages: 82,
  RoomPollCreated: 83,
  RoomPollUpdated: 84,
  RoomInfo: 90,
  RoomList: 91,
  UserKicked: 100,
  UserBanned: 101,
  UserMuted: 102,
  RoomTransferred: 111,
  ModPromoted: 112,
  ModDemoted: 113,
  TeamPromoted: 117,
  TeamDemoted: 118,
  RoomTopicUpdated: 114,
  SlowmodeUpdated: 115,
  AnnouncementUpdated: 116,
  BrowseRoomsData: 120,
  UnreadCounts: 133,
  RoomReadReceipts: 134,
  ReportAcked: 140,
  ReportsData: 141,
  ModLogData: 142,
  UserUnbanned: 143,
  UserUnmuted: 144,
  TeamMembersData: 145,
  GlobalBanned: 146,
  GlobalUnbanned: 147,
  DMBlocked: 160,
  DMUnblocked: 161,
  DMPrivacyUpdated: 162,
  UserSettings: 163,
  RoomSettingsUpdated: 119,
  RainNotification: 180,
  RainError: 181,
  DMReactionAdded: 57,
  DMReactionRemoved: 58,
  RoomDeleted: 190,
  RoomPing: 191,
  TipNotification: 192,
  TipError: 193,
  WelcomeDismissed: 194,
  GameResult: 186,
  GameError: 187,
  GameTick: 188,
  GameChallenge: 189,
  DMPinned: 195,
  DMUnpinned: 196,
  PinnedDMs: 197,
  ThreadData: 198,
  PresenceUpdated: 200,
  RoomActivity: 201,
  // Balance & Betting
  BalanceUpdate: 210,
  DepositInfo: 211,
  WithdrawResult: 212,
  LeaderboardData: 213,
  // Spectator & Staking
  StakingUpdate: 220,
  StakingSettled: 221,
  MatchUpdate: 222,
  MatchInfo: 223,
  AgentStatsData: 225,
  MatchHistoryData: 226,
  // Spectator Queue
  QueueJoined: 230,
  QueueLeft: 231,
  QueueStatus: 232,
  // Agent query
  CrashRoomsData: 240,
  MyQueueData: 241,
  // Session games (mines, tower, etc.)
  GameState: 250,
  // HexWar
  HexWarTick: 260,
  HexWarState: 261,
  HexWarResult: 262,
  HexWarError: 263,
  HexWarRoomsData: 264,
  HexWarQueueUpdate: 265,
  // Heartbeat
  HeartbeatAck: 199,
  // Live Feed
  LiveFeedBatch: 270,
  LiveFeedEvent: 271,
} as const;
export type ServerOp = (typeof ServerOp)[keyof typeof ServerOp];


// Types used by the MCP server (compile-time only)

export type RoomType = "chat" | "game" | "spectator";

export interface Room {
  id: string;
  tokenMint: string;
  name: string;
  description: string | null;
  createdBy: string;              // account ID of whoever created this room
  tierLevel: number;
  minTokens: number;
  isPublic: boolean;
  isVerified: boolean;            // true if creator is the token claimer
  isModOnly: boolean;             // only room owner + moderators can access
  allowSpectators: boolean;       // non-holders can view chat but not write
  isOpen: boolean;                // fully open room - no tokens required to chat
  modWriteOnly: boolean;          // announcement: mods/owner write, everyone reads
  roomIcon: string | null;        // emoji or short text icon for sidebar display
  gamesEnabled: boolean;          // master toggle: allow games in this room
  disabledGames: string | null;   // comma-separated list of disabled game types
  allowAgents: boolean;           // allow AI agents in this room
  roomType: RoomType;             // 'chat' | 'game' | 'spectator'
  lastActivityAt: number;         // for auto-purge of dead rooms
  createdAt: number;
}

export interface RoomWithAccess extends Room {
  tokenTicker: string;
  tokenName: string;
  hasAccess: boolean;
  /** Can this user send messages? Tier-0 rooms are read-only without tokens. */
  canWrite: boolean;
  userBalance: number;
  onlineCount: number;
  tags?: string[];
}

export interface Token {
  mintAddress: string;
  name: string;
  ticker: string;
  projectName: string | null;
  imageUrl: string | null;
  totalSupply: number;
  decimals: number; // 6 for PumpFun, 9 for standard SPL tokens
  // Claiming = proving you're the project owner (verified badge)
  // Does NOT grant exclusive room control - anyone can make rooms for any token
  isClaimed: boolean;
  claimedBy: string | null;  // account ID
  createdAt: number;
}

export interface TokenWithRooms extends Token {
  rooms: RoomWithAccess[];
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  userReacted: boolean;
  reactors?: string[]; // display names of users who reacted
}

export interface Message {
  id: string;
  roomId: string;
  authorId: string;               // account ID (or '__game__', '__system__', '__rain__')
  authorName: string | null;
  authorPicUrl: string | null;
  isAgent?: boolean;
  content: string;
  replyToId: string | null;
  replyToContent: string | null;
  replyToAuthor: string | null;
  reactions: ReactionSummary[];
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  pinnedAt: number | null;
  pinnedBy: string | null;        // account ID
  replyCount: number;
}

export interface DirectMessage {
  id: string;
  fromId: string;                 // sender account ID
  fromName: string | null;
  fromPicUrl: string | null;
  isAgent?: boolean;
  toId: string;                   // recipient account ID
  toName: string | null;
  toPicUrl: string | null;
  content: string;
  createdAt: number;
  editedAt: number | null;
  readAt: number | null;
  replyToId: string | null;
  replyToContent: string | null;
  replyToAuthor: string | null;
  reactions?: ReactionSummary[];
  pinnedAt: number | null;
  pinnedBy: string | null;        // account ID
}
