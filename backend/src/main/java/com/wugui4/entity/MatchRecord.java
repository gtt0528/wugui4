package com.wugui4.entity;

import jakarta.persistence.*;
import java.time.LocalDateTime;

/** 对局记录：一局（一次 startRound 到 ROUND_END） */
@Entity
@Table(name = "t_match")
public class MatchRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** LOCAL=单机上报 / ONLINE=联机 */
    @Column(nullable = false, length = 16)
    private String mode;

    private Integer totalRounds = 1;

    @Column(nullable = false)
    private LocalDateTime startTime = LocalDateTime.now();

    private LocalDateTime endTime = LocalDateTime.now();

    public Long getId() { return id; }
    public String getMode() { return mode; }
    public void setMode(String mode) { this.mode = mode; }
    public Integer getTotalRounds() { return totalRounds; }
    public void setTotalRounds(Integer totalRounds) { this.totalRounds = totalRounds; }
    public LocalDateTime getStartTime() { return startTime; }
    public void setStartTime(LocalDateTime startTime) { this.startTime = startTime; }
    public LocalDateTime getEndTime() { return endTime; }
    public void setEndTime(LocalDateTime endTime) { this.endTime = endTime; }
}
