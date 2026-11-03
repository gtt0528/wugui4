package com.wugui4.entity;

import jakarta.persistence.*;
import java.time.LocalDateTime;

/** 对局中的玩家：一局 4 条（含单机局的本地玩家） */
@Entity
@Table(name = "t_match_player", indexes = {
        @Index(name = "idx_user", columnList = "userId"),
        @Index(name = "idx_match", columnList = "matchId")
})
public class MatchPlayer {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "matchId", nullable = false)
    private Long matchId;

    @Column(name = "userId", nullable = false)
    private Long userId;

    private Integer seat;

    /** 结果：WIN=获胜 / LOSE=失败（乌龟4 里先出完牌者胜） */
    @Column(nullable = false, length = 8)
    private String result;

    private Integer score = 0;

    @Column(nullable = false)
    private LocalDateTime createTime = LocalDateTime.now();

    public Long getId() { return id; }
    public Long getMatchId() { return matchId; }
    public void setMatchId(Long matchId) { this.matchId = matchId; }
    public Long getUserId() { return userId; }
    public void setUserId(Long userId) { this.userId = userId; }
    public Integer getSeat() { return seat; }
    public void setSeat(Integer seat) { this.seat = seat; }
    public String getResult() { return result; }
    public void setResult(String result) { this.result = result; }
    public Integer getScore() { return score; }
    public void setScore(Integer score) { this.score = score; }
    public LocalDateTime getCreateTime() { return createTime; }
    public void setCreateTime(LocalDateTime createTime) { this.createTime = createTime; }
}
