package com.wugui4.repo;

import com.wugui4.entity.MatchPlayer;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;

public interface MatchPlayerRepository extends JpaRepository<MatchPlayer, Long> {

    /** 我的最近对局（倒序） */
    List<MatchPlayer> findByUserIdOrderByIdDesc(Long userId, Pageable pageable);

    /** 胜利排行榜：按获胜数倒序 */
    @Query("select m.userId, count(m) as wins from MatchPlayer m " +
           "where m.result = 'WIN' group by m.userId order by wins desc")
    List<Object[]> rankByWins(Pageable pageable);
}
