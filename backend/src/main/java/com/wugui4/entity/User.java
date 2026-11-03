package com.wugui4.entity;

import jakarta.persistence.*;
import java.time.LocalDateTime;

/** 用户表：游客与微信登录共用，openid 为微信唯一标识（游客为 guest_xxx） */
@Entity
@Table(name = "t_user", indexes = @Index(name = "uk_openid", columnList = "openid", unique = true))
public class User {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    /** 微信 openid；游客 = guest_ + uuid */
    @Column(nullable = false, unique = true, length = 64)
    private String openid;

    @Column(nullable = false, length = 32)
    private String nickname;

    @Column(columnDefinition = "TEXT")
    private String avatar;

    /** 性别：0 未知 1 男 2 女（首次进入时填写） */
    @Column(nullable = false)
    private Integer gender = 0;

    private Integer totalGames = 0;   // 累计对局数
    private Integer totalWins = 0;    // 累计获胜数

    @Column(nullable = false)
    private LocalDateTime createTime = LocalDateTime.now();

    private LocalDateTime lastLoginTime = LocalDateTime.now();

    public Long getId() { return id; }
    public String getOpenid() { return openid; }
    public void setOpenid(String openid) { this.openid = openid; }
    public String getNickname() { return nickname; }
    public void setNickname(String nickname) { this.nickname = nickname; }
    public String getAvatar() { return avatar; }
    public void setAvatar(String avatar) { this.avatar = avatar; }
    public Integer getGender() { return gender; }
    public void setGender(Integer gender) { this.gender = gender; }
    public Integer getTotalGames() { return totalGames; }
    public void setTotalGames(Integer totalGames) { this.totalGames = totalGames; }
    public Integer getTotalWins() { return totalWins; }
    public void setTotalWins(Integer totalWins) { this.totalWins = totalWins; }
    public LocalDateTime getCreateTime() { return createTime; }
    public void setCreateTime(LocalDateTime createTime) { this.createTime = createTime; }
    public LocalDateTime getLastLoginTime() { return lastLoginTime; }
    public void setLastLoginTime(LocalDateTime lastLoginTime) { this.lastLoginTime = lastLoginTime; }
}
