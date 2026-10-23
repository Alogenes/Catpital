/** vite.config.ts 里的 bgmTracks() 插件：构建时扫描 public/bgm/ 下的音频文件 */
declare module 'virtual:bgm-tracks' {
  const tracks: ReadonlyArray<{
    /** 去掉扩展名的文件名，同名不同格式共用一个 id */
    id: string;
    title: string;
    /** 按优先级排好（opus 在前），每项带 MIME 类型供 canPlayType 判断 */
    sources: ReadonlyArray<{ file: string; type: string }>;
  }>;
  export default tracks;
}
